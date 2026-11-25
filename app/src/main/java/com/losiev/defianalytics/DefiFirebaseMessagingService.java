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
        show(title, body, tag);
    }

    private void show(String title, String body, String tag) {
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
        }

        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_alert)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build();

        // Одинаковый tag заменяет предыдущее уведомление того же алерта, разные — копятся
        int id = (tag != null && !tag.isEmpty()) ? tag.hashCode() : (int) (System.currentTimeMillis() & 0x7fffffff);
        nm.notify(id, n);
    }
}
