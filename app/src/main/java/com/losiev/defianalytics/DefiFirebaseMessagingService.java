package com.losiev.defianalytics;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Пуш-алерты DeFi Analytics.
 *
 * Воркер шлёт только data-блок (title, body, tag) с приоритетом HIGH, а баннер рисуем мы сами:
 * так уведомление приходит и при закрытом приложении, и на оболочках вроде MIUI (тот же приём, что в Options Analyst).
 * Токен в приложение подтягивает страница (AndroidBridge.requestPushToken), здесь его только запоминаем.
 */
public class DefiFirebaseMessagingService extends FirebaseMessagingService {

    static final String CHANNEL_ID = "defi_alerts";
    static final String CHANNEL_SILENT = "defi_alerts_silent";
    private static final String PREFS = "DefiPushPrefs";

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        p.edit().putString("fcm_token", token).apply();
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        String title = data != null ? data.get("title") : null;
        String body = data != null ? data.get("body") : null;
        String tag = data != null ? data.get("tag") : null;
        if (title == null && message.getNotification() != null) {
            title = message.getNotification().getTitle();
            body = message.getNotification().getBody();
        }
        if (title == null) title = "DeFi Analytics";
        if (body == null) body = "";
        String snd = data != null ? data.get("sound") : null;
        show(title, body, tag, !"0".equals(snd));
    }

    private void show(String title, String body, String tag, boolean sound) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "DeFi alerts", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Health Factor and price alerts");
            ch.enableVibration(true);
            ch.setVibrationPattern(new long[]{0, 250, 250, 250});
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);

            // Звук задаётся на уровне канала (Android 8+), поэтому для алертов «без звука» — отдельный тихий канал
            NotificationChannel quiet = new NotificationChannel(
                    CHANNEL_SILENT, "DeFi alerts (silent)", NotificationManager.IMPORTANCE_DEFAULT);
            quiet.setDescription("Alerts without sound");
            quiet.setSound(null, null);
            quiet.enableVibration(false);
            quiet.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(quiet);
        }

        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new NotificationCompat.Builder(this, sound ? CHANNEL_ID : CHANNEL_SILENT)
                .setSmallIcon(R.drawable.ic_stat_alert)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(sound ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setDefaults(sound ? NotificationCompat.DEFAULT_ALL : 0)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build();

        // Одинаковый tag заменяет предыдущее уведомление того же алерта, разные — копятся
        int id = (tag != null && !tag.isEmpty()) ? tag.hashCode() : (int) (System.currentTimeMillis() & 0x7fffffff);
        nm.notify(id, n);
    }
}
