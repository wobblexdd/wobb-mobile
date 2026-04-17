package com.wobbmobile.wobb;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.VpnService;
import android.os.Build;

import java.util.UUID;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;

import com.facebook.react.bridge.ActivityEventListener;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.BaseActivityEventListener;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.module.annotations.ReactModule;

/**
 * React Native bridge for starting and stopping the Android VPN tunnel.
 *
 * This module is intentionally thin: it handles permission negotiation and
 * forwards runtime config JSON to {@link WobbVpnService}, where libxray or a
 * Go-mobile wrapper can be attached.
 */
@ReactModule(name = WobbVpnModule.NAME)
public class WobbVpnModule extends ReactContextBaseJavaModule {
    public static final String NAME = "WobbVpnModule";
    private static final int VPN_REQUEST_CODE = 44127;
    private static final String PREFS_NAME = "wobb_mobile_prefs";

    @Nullable
    private Promise pendingPreparePromise;

    private final ActivityEventListener activityEventListener = new BaseActivityEventListener() {
        @Override
        public void onActivityResult(Activity activity, int requestCode, int resultCode, Intent data) {
            if (requestCode != VPN_REQUEST_CODE || pendingPreparePromise == null) {
                return;
            }

            boolean granted = resultCode == Activity.RESULT_OK;
            WritableMap result = Arguments.createMap();
            result.putBoolean("granted", granted);
            result.putBoolean("requested", true);
            pendingPreparePromise.resolve(result);
            pendingPreparePromise = null;
            WobbVpnEventEmitter.emitPermissionStatus(granted ? "granted" : "denied");
        }
    };

    public WobbVpnModule(ReactApplicationContext reactContext) {
        super(reactContext);
        reactContext.addActivityEventListener(activityEventListener);
        WobbVpnEventEmitter.register(reactContext);
    }

    @NonNull
    @Override
    public String getName() {
        return NAME;
    }

    /**
     * Requests Android VPN permission from the user if required.
     */
    @ReactMethod
    public void prepareVpn(Promise promise) {
        Activity activity = getCurrentActivity();
        if (activity == null) {
            promise.reject("E_NO_ACTIVITY", "Current activity is unavailable.");
            return;
        }

        Intent prepareIntent = VpnService.prepare(activity);
        if (prepareIntent == null) {
            WritableMap result = Arguments.createMap();
            result.putBoolean("granted", true);
            result.putBoolean("requested", false);
            promise.resolve(result);
            return;
        }

        pendingPreparePromise = promise;
        activity.startActivityForResult(prepareIntent, VPN_REQUEST_CODE);
        WobbVpnEventEmitter.emitPermissionStatus("requested");
    }

    @ReactMethod
    public void addListener(String eventName) {
        // Required for NativeEventEmitter compatibility.
    }

    @ReactMethod
    public void removeListeners(double count) {
        // Required for NativeEventEmitter compatibility.
    }

    /**
     * Starts the foreground VPN service and forwards the runtime config JSON.
     *
     * The service is expected to parse the config and initialize libxray or a
     * Go-mobile bound engine in-process.
     */
    @ReactMethod
    public void startVpn(String configJson, Promise promise) {
        ReactApplicationContext context = getReactApplicationContext();
        WobbVpnEventEmitter.register(context);

        if (configJson == null || configJson.trim().isEmpty()) {
            promise.reject("E_VPN_CONFIG", "VPN config JSON is empty.");
            return;
        }

        Intent intent = new Intent(context, WobbVpnService.class);
        intent.setAction(WobbVpnService.ACTION_START);
        intent.putExtra(WobbVpnService.EXTRA_CONFIG_JSON, configJson);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(context, intent);
            } else {
                context.startService(intent);
            }
            WobbVpnEventEmitter.emitVpnStatus("connecting");
            promise.resolve(true);
        } catch (Exception exception) {
            WobbVpnEventEmitter.emitVpnStatus("error");
            promise.reject("E_VPN_START", exception);
        }
    }

    /**
     * Stops the running VPN service if present.
     */
    @ReactMethod
    public void stopVpn(Promise promise) {
        ReactApplicationContext context = getReactApplicationContext();
        WobbVpnEventEmitter.register(context);
        Intent intent = new Intent(context, WobbVpnService.class);
        intent.setAction(WobbVpnService.ACTION_STOP);

        try {
            WobbVpnEventEmitter.emitVpnStatus("disconnecting");
            context.startService(intent);
            promise.resolve(true);
        } catch (Exception exception) {
            WobbVpnEventEmitter.emitVpnStatus("error");
            promise.reject("E_VPN_STOP", exception);
        }
    }

    @ReactMethod
    public void setItem(String key, String value, Promise promise) {
        try {
            SharedPreferences preferences = getPreferences();
            preferences.edit().putString(key, value).apply();
            promise.resolve(null);
        } catch (Exception exception) {
            promise.reject("E_STORAGE_WRITE", exception);
        }
    }

    @ReactMethod
    public void getItem(String key, Promise promise) {
        try {
            SharedPreferences preferences = getPreferences();
            promise.resolve(preferences.getString(key, null));
        } catch (Exception exception) {
            promise.reject("E_STORAGE_READ", exception);
        }
    }

    @ReactMethod
    public void removeItem(String key, Promise promise) {
        try {
            SharedPreferences preferences = getPreferences();
            preferences.edit().remove(key).apply();
            promise.resolve(null);
        } catch (Exception exception) {
            promise.reject("E_STORAGE_REMOVE", exception);
        }
    }

    @ReactMethod
    public void setClipboardText(String value, Promise promise) {
        try {
            ClipboardManager clipboard = (ClipboardManager) getReactApplicationContext().getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard == null) {
                promise.reject("E_CLIPBOARD", "Clipboard service is unavailable.");
                return;
            }

            ClipData clipData = ClipData.newPlainText("wobb", value == null ? "" : value);
            clipboard.setPrimaryClip(clipData);
            promise.resolve(true);
        } catch (Exception exception) {
            promise.reject("E_CLIPBOARD_WRITE", exception);
        }
    }

    @ReactMethod
    public void getClipboardText(Promise promise) {
        try {
            ClipboardManager clipboard = (ClipboardManager) getReactApplicationContext().getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard == null) {
                promise.resolve(null);
                return;
            }

            ClipData clipData = clipboard.getPrimaryClip();
            if (clipData == null || clipData.getItemCount() == 0) {
                promise.resolve(null);
                return;
            }

            CharSequence text = clipData.getItemAt(0).coerceToText(getReactApplicationContext());
            promise.resolve(text == null ? null : text.toString());
        } catch (Exception exception) {
            promise.reject("E_CLIPBOARD_READ", exception);
        }
    }

    @ReactMethod
    public void getOrCreateInstallationId(Promise promise) {
        try {
            SharedPreferences preferences = getPreferences();
            String existing = preferences.getString("installation_id", null);
            if (existing != null && !existing.isEmpty()) {
                promise.resolve(existing);
                return;
            }

            String created = UUID.randomUUID().toString();
            preferences.edit().putString("installation_id", created).apply();
            promise.resolve(created);
        } catch (Exception exception) {
            promise.reject("E_INSTALLATION_ID", exception);
        }
    }

    private SharedPreferences getPreferences() {
        return getReactApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }
}
