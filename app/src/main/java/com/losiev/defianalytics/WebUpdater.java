package com.losiev.defianalytics;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;

/**
 * Обновление веб-части (index.html) без переустановки APK.
 *
 * Безопасность: новая версия принимается ТОЛЬКО если подпись ECDSA P-256 над
 * "defi-web|<версия>|<sha256>" проверена публичным ключом, зашитым в APK. Приватный ключ
 * лежит только в GitHub Secrets. Подмена файла на сервере/в Pages без ключа не пройдёт.
 * Откат на старую версию невозможен (версия — время сборки, принимается только большая).
 * Фиксированный адрес, только https, без редиректов, лимит размера, проверка при каждом запуске.
 * Если ключ не задан или что-то не так — работает версия, вшитая в APK.
 */
final class WebUpdater {

    static final String BASE = "https://yuriilosiev-png.github.io/defi-analytics/web/";
    private static final int MAX_BYTES = 6 * 1024 * 1024;

    private final Context ctx;
    private final SharedPreferences prefs;
    private final PublicKey key;
    private final long bundledVersion;

    WebUpdater(Context c) {
        ctx = c.getApplicationContext();
        prefs = ctx.getSharedPreferences("web_ota", Context.MODE_PRIVATE);
        key = loadKey();
        bundledVersion = loadBundledVersion();
    }

    boolean enabled() {
        return key != null;
    }

    /** Файл OTA-версии, если он есть, новее вшитой и проходит проверку подписи; иначе null. */
    File verifiedFile() {
        if (key == null) return null;
        try {
            long v = prefs.getLong("v", 0);
            if (v <= bundledVersion) return null;
            File f = new File(new File(ctx.getFilesDir(), "web"), "index.html");
            if (!f.isFile() || f.length() > MAX_BYTES) return null;
            String sha = hex(sha256(readAll(new FileInputStream(f))));
            if (!sha.equals(prefs.getString("sha", ""))) return null;
            if (!verify(v, sha, prefs.getString("sig", ""))) return null;
            return f;
        } catch (Exception e) {
            return null;
        }
    }

    /** Блокирующая проверка. true — скачана и подготовлена новая версия (применится при перезагрузке страницы). */
    boolean checkAndStage() {
        if (key == null) return false;
        try {
            JSONObject m = new JSONObject(new String(
                    download(BASE + "latest.json", 4096), StandardCharsets.UTF_8));
            long v = m.getLong("v");
            String sha = m.getString("sha256").toLowerCase();
            String sig = m.getString("sig");
            long have = Math.max(bundledVersion, prefs.getLong("v", 0));
            if (v <= have) return false;                       // новее нечего
            if (!sha.matches("[0-9a-f]{64}")) return false;
            if (!verify(v, sha, sig)) return false;            // подпись не сошлась — игнорируем

            byte[] body = download(BASE + "index.html", MAX_BYTES);
            if (!hex(sha256(body)).equals(sha)) return false;  // содержимое не то, что подписано

            File dir = new File(ctx.getFilesDir(), "web");
            if (!dir.isDirectory() && !dir.mkdirs()) return false;
            File tmp = new File(dir, "index.html.tmp");
            try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(body); }
            File dst = new File(dir, "index.html");
            if (!tmp.renameTo(dst)) { if (dst.exists() && !dst.delete()) return false; if (!tmp.renameTo(dst)) return false; }
            return prefs.edit().putLong("v", v).putString("sha", sha).putString("sig", sig).commit();
        } catch (Exception e) {
            return false;
        }
    }

    // ───────────── внутреннее ─────────────

    private boolean verify(long v, String sha, String sigB64) {
        try {
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initVerify(key);
            s.update(("defi-web|" + v + "|" + sha).getBytes(StandardCharsets.UTF_8));
            return s.verify(Base64.decode(sigB64, Base64.DEFAULT));
        } catch (Exception e) {
            return false;
        }
    }

    private PublicKey loadKey() {
        try {
            String b64 = ctx.getString(R.string.web_pubkey).replaceAll("\\s", "");
            if (b64.isEmpty()) return null;
            return KeyFactory.getInstance("EC")
                    .generatePublic(new X509EncodedKeySpec(Base64.decode(b64, Base64.DEFAULT)));
        } catch (Exception e) {
            return null;
        }
    }

    private long loadBundledVersion() {
        try (InputStream in = ctx.getAssets().open("web_version.txt")) {
            return Long.parseLong(new String(readAll(in), StandardCharsets.UTF_8).trim());
        } catch (Exception e) {
            return 0L;
        }
    }

    private static byte[] download(String url, int max) throws Exception {
        if (!url.startsWith(BASE)) throw new SecurityException("bad url");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(10000);
            c.setReadTimeout(15000);
            c.setUseCaches(false);
            c.setRequestProperty("Cache-Control", "no-cache");
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            if (c.getContentLengthLong() > max) throw new Exception("too big");
            try (InputStream in = c.getInputStream()) { return readLimited(in, max); }
        } finally {
            c.disconnect();
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        try (InputStream i = in) { return readLimited(i, MAX_BYTES); }
    }

    private static byte[] readLimited(InputStream in, int max) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n, total = 0;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > max) throw new Exception("too big");
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    private static byte[] sha256(byte[] b) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(b);
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }
}
