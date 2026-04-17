package com.wobbmobile.wobb;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;

import libXray.DialerController;
import libXray.LibXray;

public class WobbVpnService extends VpnService {
    public static final String ACTION_START = "com.wobbmobile.wobb.action.START";
    public static final String ACTION_STOP = "com.wobbmobile.wobb.action.STOP";
    public static final String EXTRA_CONFIG_JSON = "com.wobbmobile.wobb.extra.CONFIG_JSON";

    private static final String CHANNEL_ID = "wobb_vpn_channel";
    private static final int NOTIFICATION_ID = 1042;

    @Nullable
    private ParcelFileDescriptor tunInterface;
    private volatile boolean starting = false;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) {
            return START_NOT_STICKY;
        }

        if (ACTION_STOP.equals(intent.getAction())) {
            WobbVpnEventEmitter.emitLog("service", "Disconnect requested by user.");
            stopTunnel();
            stopForeground(STOP_FOREGROUND_REMOVE);
            WobbVpnEventEmitter.emitVpnStatus("idle");
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_START.equals(intent.getAction())) {
            String configJson = intent.getStringExtra(EXTRA_CONFIG_JSON);
            startForeground(NOTIFICATION_ID, buildNotification());
            startTunnel(configJson);
            return START_STICKY;
        }

        return START_NOT_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return super.onBind(intent);
    }

    private Notification buildNotification() {
        createChannelIfNeeded();

        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launchIntent == null) {
            launchIntent = new Intent();
        }
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle("WOBB VPN")
            .setContentText("Self-hosted runtime is active on this device.")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(contentIntent)
            .build();
    }

    private void createChannelIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationManager manager =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

        if (manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "WOBB VPN",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("WOBB mobile VPN status");
        manager.createNotificationChannel(channel);
    }

    private synchronized void startTunnel(@Nullable String configJson) {
        stopTunnel();
        starting = true;
        WobbVpnEventEmitter.emitVpnStatus("connecting");
        WobbVpnEventEmitter.emitLog("service", "Preparing Android TUN interface.");

        Builder builder = new Builder()
            .setSession("WOBB VPN")
            .addAddress("10.0.0.2", 32)
            .addDnsServer("1.1.1.1")
            .addRoute("0.0.0.0", 0);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            builder.setMetered(false);
        }

        tunInterface = builder.establish();

        if (tunInterface == null) {
            starting = false;
            WobbVpnEventEmitter.emitLog("stderr", "Failed to establish Android VPN interface.");
            WobbVpnEventEmitter.emitVpnStatus("error");
            stopSelf();
            return;
        }

        WobbVpnEventEmitter.emitLog("service", "Android VPN interface established.");

        final String runtimeConfig = configJson == null ? "{}" : configJson;
        final int tunFd = tunInterface.getFd();

        Thread bootstrapThread = new Thread(() -> {
            try {
                logResolvedEndpoint(runtimeConfig);
                startEmbeddedCore(runtimeConfig, tunFd);
                boolean running = LibXray.getXrayState();
                WobbVpnEventEmitter.emitLog("service", "Embedded core state: " + running);
                if (!running) {
                    throw new IllegalStateException("Embedded core did not report a running state.");
                }
                WobbVpnEventEmitter.emitLog("service", "Embedded Wobb Core started.");
                WobbVpnEventEmitter.emitVpnStatus("connected");
            } catch (Exception exception) {
                WobbVpnEventEmitter.emitLog("stderr", "Failed to start embedded core: " + exception.getMessage());
                stopTunnel();
                WobbVpnEventEmitter.emitVpnStatus("error");
                stopSelf();
            } finally {
                starting = false;
            }
        }, "WobbVpnCoreStart");
        bootstrapThread.start();
    }

    private void registerDialerController() {
        DialerController controller = new DialerController() {
            @Override
            public boolean protectFd(long fd) {
                return protect((int) fd);
            }
        };

        LibXray.registerDialerController(controller);
        LibXray.registerListenerController(controller);
    }

    private void logResolvedEndpoint(String configString) throws Exception {
        JSONObject root = new JSONObject(configString);
        JSONArray outbounds = root.optJSONArray("outbounds");
        if (outbounds == null || outbounds.length() == 0) {
            throw new IllegalArgumentException("Runtime profile is missing outbounds.");
        }

        JSONObject proxy = null;
        for (int index = 0; index < outbounds.length(); index++) {
            JSONObject candidate = outbounds.optJSONObject(index);
            if (candidate == null) {
                continue;
            }

            if ("proxy".equalsIgnoreCase(candidate.optString("tag"))) {
                proxy = candidate;
                break;
            }
        }

        if (proxy == null) {
            proxy = outbounds.optJSONObject(0);
        }

        if (proxy == null) {
            throw new IllegalArgumentException("Runtime profile does not include a proxy outbound.");
        }

        JSONObject settings = proxy.optJSONObject("settings");
        JSONArray vnext = settings != null ? settings.optJSONArray("vnext") : null;
        JSONObject server = vnext != null ? vnext.optJSONObject(0) : null;
        JSONArray users = server != null ? server.optJSONArray("users") : null;
        JSONObject user = users != null ? users.optJSONObject(0) : null;
        JSONObject streamSettings = proxy.optJSONObject("streamSettings");
        JSONObject realitySettings = streamSettings != null ? streamSettings.optJSONObject("realitySettings") : null;

        String address = server != null ? server.optString("address", "") : "";
        int port = server != null ? server.optInt("port", 0) : 0;
        String uuid = user != null ? user.optString("id", "") : "";
        String security = streamSettings != null ? streamSettings.optString("security", "") : "";
        String serverName = realitySettings != null ? realitySettings.optString("serverName", "") : "";
        String publicKey = realitySettings != null ? realitySettings.optString("publicKey", "") : "";
        String shortId = realitySettings != null ? realitySettings.optString("shortId", "") : "";

        if (address.isEmpty() || port < 1 || port > 65535 || uuid.isEmpty()) {
            throw new IllegalArgumentException("Runtime profile is missing address, port, or client UUID.");
        }

        if ("reality".equalsIgnoreCase(security)) {
            if (serverName.isEmpty() || publicKey.isEmpty() || shortId.isEmpty()) {
                throw new IllegalArgumentException("Runtime profile is missing REALITY fields.");
            }
        }

        WobbVpnEventEmitter.emitLog("service", "Runtime endpoint: " + address + ":" + port + " (security=" + security + ")");
    }

    private void startEmbeddedCore(String configString, int tunFd) throws Exception {
        registerDialerController();
        WobbVpnEventEmitter.emitLog("service", "Starting embedded core with Android tunnel fd=" + tunFd + ".");
        WobbVpnEventEmitter.emitLog("service", "Calling libXray.LibXray.runXrayFromJSON(...).");
        String result = LibXray.runXrayFromJSON(configString);
        WobbVpnEventEmitter.emitLog("service", "LibXray response: " + result);
        WobbVpnEventEmitter.emitLog("service", "Current mobile bridge starts libXray from JSON only; verify live traffic before trusting the tunnel.");
    }

    private void stopEmbeddedCore() {
        try {
            if (LibXray.getXrayState()) {
                WobbVpnEventEmitter.emitLog("service", "Stopping embedded Wobb Core bridge.");
            }
            String result = LibXray.stopXray();
            WobbVpnEventEmitter.emitLog("service", "Embedded Wobb Core stopped: " + result);
        } catch (Exception exception) {
            WobbVpnEventEmitter.emitLog("stderr", "Embedded core shutdown hook unavailable: " + exception.getMessage());
        }
    }

    private synchronized void stopTunnel() {
        stopEmbeddedCore();

        if (tunInterface == null) {
            return;
        }

        try {
            tunInterface.close();
            WobbVpnEventEmitter.emitLog("service", "Android VPN interface closed.");
        } catch (IOException exception) {
            WobbVpnEventEmitter.emitLog("stderr", "Failed to close Android VPN interface: " + exception.getMessage());
        } finally {
            tunInterface = null;
        }
    }

    @Override
    public void onDestroy() {
        starting = false;
        stopTunnel();
        WobbVpnEventEmitter.emitVpnStatus("idle");
        super.onDestroy();
    }
}
