package com.losiev.defianalytics;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.IntentSender;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.File;
import java.io.FileInputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;

import com.google.android.play.core.appupdate.AppUpdateManager;
import com.google.android.play.core.appupdate.AppUpdateManagerFactory;
import com.google.android.play.core.appupdate.AppUpdateOptions;
import com.google.android.play.core.install.model.AppUpdateType;
import com.google.android.play.core.install.model.UpdateAvailability;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * DeFi Analytics — оболочка над WebView.
 *
 * Безопасность:
 *  - страница (index.html) лежит ВНУТРИ APK и отдаётся через WebViewAssetLoader по
 *    https://appassets.androidplatform.net/assets/…  Никакого удалённого кода: что вошло в сборку,
 *    то и выполняется. Работает офлайн и стартует быстрее, чем загрузка сайта.
 *  - навигация заперта: внутри WebView открывается только наш адрес, https-ссылки уходят в браузер,
 *    всё остальное (http, intent:, file:, javascript: …) блокируется.
 *  - доступ к файлам и контенту отключён, mixed content запрещён, SSL-ошибки не пропускаются.
 *  - мост AndroidBridge минимальный (версия + запуск обновления) и проверяет, что вызов идёт
 *    со страницы приложения.
 */
public class MainActivity extends ComponentActivity {

    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + APP_HOST + "/assets/index.html";
    private static final int REQ_UPDATE = 7001;
    private static final int BG_COLOR = 0xFF080C18;

    private WebView webView;
    /** Заполняется на UI-потоке, читается из потока JS-моста. */
    private volatile boolean pageTrusted = false;

    // Обновление веб-части без переустановки (подписанные файлы, см. WebUpdater)
    private WebUpdater updater;
    private final ExecutorService otaExec = Executors.newSingleThreadExecutor();
    private volatile boolean otaPending = false;   // новая версия скачана, ждёт перезагрузки страницы
    private long lastOtaCheck = 0, stoppedAt = 0;

    // Разрешение на уведомления (Android 13+): запрашивается только по кнопке на экране «Алерты»
    private final ActivityResultLauncher<String> notifPermLauncher = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(),
            granted -> runJs("window.onPushPermission && window.onPushPermission(" + granted + ");"));

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        updater = new WebUpdater(this);
        final WebViewAssetLoader.PathHandler bundled = new WebViewAssetLoader.AssetsPathHandler(this);
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(APP_HOST)
                .addPathHandler("/assets/", path -> {
                    // index.html: проверенная OTA-версия, если есть; иначе вшитая в APK
                    if ("index.html".equals(path)) {
                        File f = updater.verifiedFile();
                        if (f != null) {
                            try {
                                return new WebResourceResponse("text/html", "utf-8", new FileInputStream(f));
                            } catch (Exception ignored) { /* упадём на вшитую */ }
                        }
                    }
                    return bundled.handle(path);
                })
                .build();

        webView = new WebView(this);
        webView.setBackgroundColor(BG_COLOR);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);          // приложение целиком на JS
        s.setDomStorageEnabled(true);          // localStorage: кошельки, настройки, снапшоты
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);                    // системный размер шрифта не ломает вёрстку
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(true);
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(
                (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        webView.addJavascriptInterface(new AppBridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // Наши файлы — из APK; всё остальное (API бирж и RPC) идёт в сеть как обычно
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isAppUrl(uri)) {
                    return false;                              // внутренняя навигация
                }
                if ("https".equals(uri.getScheme())) {
                    openExternal(uri);                         // ссылки (Telegram, документация) — в браузер
                }
                return true;                                   // остальное блокируем
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageTrusted = url != null && isAppUrl(Uri.parse(url));
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler,
                                           android.net.http.SslError error) {
                handler.cancel();                              // никогда не принимаем плохие сертификаты
            }
        });

        // Корневой контейнер: отступы под системные панели, вырез и клавиатуру
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG_COLOR);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout()
                    | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        setContentView(root);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });

        // Состояние восстанавливаем, только если оно реально есть; иначе грузим стартовую страницу
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(START_URL);
        }
        checkWebUpdate();
    }

    /** Фоновая проверка обновления веб-части (не чаще раза в 30 минут). */
    private void checkWebUpdate() {
        if (updater == null || !updater.enabled()) return;
        long now = System.currentTimeMillis();
        if (now - lastOtaCheck < 30 * 60 * 1000L) return;
        lastOtaCheck = now;
        otaExec.execute(() -> { if (updater.checkAndStage()) otaPending = true; });
    }

    // ───────────────────────── навигация ─────────────────────────

    private static boolean isAppUrl(Uri u) {
        return u != null
                && "https".equals(u.getScheme())
                && APP_HOST.equalsIgnoreCase(u.getHost())
                && u.getPort() == -1
                && u.getPath() != null
                && u.getPath().startsWith("/assets/");
    }

    private void openExternal(Uri uri) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, uri);
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(i);
        } catch (ActivityNotFoundException ignored) {
            // нет приложения для ссылки — молча игнорируем
        }
    }

    // ───────────────────────── мост JS ↔ Android ─────────────────────────

    public class AppBridge {
        @SuppressWarnings("deprecation")
        @JavascriptInterface
        public int getVersionCode() {
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                        ? pi.getLongVersionCode() : pi.versionCode;
                return (int) code;
            } catch (Exception e) {
                return 0;
            }
        }

        @JavascriptInterface
        public String getVersionName() {
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                return pi.versionName == null ? "" : pi.versionName;
            } catch (Exception e) {
                return "";
            }
        }

        /** Состояние пушей: разрешение на уведомления и подключён ли Firebase (есть google-services.json). */
        @JavascriptInterface
        public String pushStatus() {
            boolean perm = notificationsAllowed();
            return "{\"permission\":" + perm + ",\"firebase\":" + firebaseReady() + "}";
        }

        /** Просит разрешение на уведомления (Android 13+); результат — window.onPushPermission(bool). */
        @JavascriptInterface
        public void requestPushPermission() {
            if (!pageTrusted) return;
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(
                        MainActivity.this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS);
                } else {
                    runJs("window.onPushPermission && window.onPushPermission(" + notificationsAllowed() + ");");
                }
            });
        }

        /** Просит FCM-токен; ответ — window.onPushToken(token) или window.onPushTokenError(text). */
        @JavascriptInterface
        public void requestPushToken() {
            if (!pageTrusted) return;
            runOnUiThread(MainActivity.this::fetchPushToken);
        }

        /** Кнопка «Установить» в баннере обновления. */
        @JavascriptInterface
        public void startUpdate() {
            if (!pageTrusted) return;                      // только со страницы приложения
            runOnUiThread(MainActivity.this::startPlayUpdate);
        }
    }

    // ───────────────────────── пуш-алерты (FCM) ─────────────────────────

    private boolean notificationsAllowed() {
        boolean perm = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(
                this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        return perm && NotificationManagerCompat.from(this).areNotificationsEnabled();
    }

    /** Firebase инициализируется, только если в сборку попал google-services.json. */
    private boolean firebaseReady() {
        try {
            return !FirebaseApp.getApps(this).isEmpty();
        } catch (Throwable t) {
            return false;
        }
    }

    private void fetchPushToken() {
        if (!firebaseReady()) {
            runJs("window.onPushTokenError && window.onPushTokenError('firebase_not_configured');");
            return;
        }
        try {
            FirebaseMessaging.getInstance().getToken()
                    .addOnSuccessListener(token -> runJs("window.onPushToken && window.onPushToken("
                            + org.json.JSONObject.quote(token) + ");"))
                    .addOnFailureListener(e -> runJs("window.onPushTokenError && window.onPushTokenError("
                            + org.json.JSONObject.quote(String.valueOf(e.getMessage())) + ");"));
        } catch (Throwable t) {
            runJs("window.onPushTokenError && window.onPushTokenError("
                    + org.json.JSONObject.quote(String.valueOf(t.getMessage())) + ");");
        }
    }

    /** Выполняет JS на странице приложения (только если открыта наша страница). */
    private void runJs(String js) {
        runOnUiThread(() -> {
            if (webView != null && pageTrusted) webView.evaluateJavascript(js, null);
        });
    }

    // ───────────────────────── обновление через Google Play ─────────────────────────

    private void startPlayUpdate() {
        final AppUpdateManager mgr = AppUpdateManagerFactory.create(this);
        mgr.getAppUpdateInfo()
                .addOnSuccessListener(info -> {
                    if (info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE
                            && info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE)) {
                        try {
                            mgr.startUpdateFlowForResult(info, this,
                                    AppUpdateOptions.newBuilder(AppUpdateType.IMMEDIATE).build(),
                                    REQ_UPDATE);
                        } catch (IntentSender.SendIntentException e) {
                            openPlayListing();
                        }
                    } else {
                        openPlayListing();                 // Play ещё не раздал обновление
                    }
                })
                .addOnFailureListener(e -> openPlayListing()); // установка не из Play (тестовый APK)
    }

    private void openPlayListing() {
        String pkg = getPackageName();
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg)));
        } catch (ActivityNotFoundException e) {
            openExternal(Uri.parse("https://play.google.com/store/apps/details?id=" + pkg));
        }
    }

    // ───────────────────────── жизненный цикл ─────────────────────────

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        // Новая версия страницы скачана и приложение было свёрнуто > 1 мин — применяем
        if (otaPending && stoppedAt > 0 && System.currentTimeMillis() - stoppedAt > 60000L && webView != null) {
            otaPending = false;
            webView.loadUrl(START_URL);
        }
        checkWebUpdate();
        // Если пользователь свернул приложение посреди обновления — Play просит продолжить
        final AppUpdateManager mgr = AppUpdateManagerFactory.create(this);
        mgr.getAppUpdateInfo().addOnSuccessListener(info -> {
            if (info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS) {
                try {
                    mgr.startUpdateFlowForResult(info, this,
                            AppUpdateOptions.newBuilder(AppUpdateType.IMMEDIATE).build(), REQ_UPDATE);
                } catch (IntentSender.SendIntentException ignored) {
                    // продолжим при следующем запуске
                }
            }
        });
    }

    @Override
    protected void onStop() {
        stoppedAt = System.currentTimeMillis();
        super.onStop();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        otaExec.shutdown();
        if (webView != null) {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) parent.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
