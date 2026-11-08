package id.freecolor.underwater;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

@CapacitorPlugin(name = "FreeColorGallery")
public class FreeColorGalleryPlugin extends Plugin {

    private static final String TAG = "FreeColorGallery";

    private static class SessionData {
        OutputStream fos;
        Uri mediaUri;
        File savedFile;
        boolean savedViaMediaStore;
        String mimeType;
        String filename;
        boolean isVideo;
        long nowSec;
        long totalBytes;
    }

    private final Map<String, SessionData> activeSessions = new HashMap<>();

    private Uri createMediaStoreUri(ContentResolver resolver, String filename, String mimeType, boolean isVideo, long nowSec, long nowMs) {
        String primaryDir = isVideo ? "Movies/FreeColor/" : "Pictures/FreeColor/";
        String fallbackDir = isVideo ? "Movies/" : "Pictures/";
        Uri collection = isVideo ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;

        // Try 1: with primaryDir (trailing slash is mandatory on Android Q+)
        try {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            cv.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
            cv.put(MediaStore.MediaColumns.RELATIVE_PATH, primaryDir);
            cv.put(MediaStore.MediaColumns.DATE_ADDED, nowSec);
            cv.put(MediaStore.MediaColumns.DATE_MODIFIED, nowSec);
            cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
            if (!isVideo) cv.put(MediaStore.Images.Media.DATE_TAKEN, nowMs);
            Uri uri = resolver.insert(collection, cv);
            if (uri != null) return uri;
        } catch (Throwable t) {
            Log.w(TAG, "MediaStore insert 1 failed: " + t.getMessage());
        }

        // Try 2: without IS_PENDING (some Android 10/11 ROMs fail with IS_PENDING)
        try {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            cv.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
            cv.put(MediaStore.MediaColumns.RELATIVE_PATH, primaryDir);
            if (!isVideo) cv.put(MediaStore.Images.Media.DATE_TAKEN, nowMs);
            Uri uri = resolver.insert(collection, cv);
            if (uri != null) return uri;
        } catch (Throwable t) {
            Log.w(TAG, "MediaStore insert 2 failed: " + t.getMessage());
        }

        // Try 3: fallback standard root directory (e.g. Pictures/ or Movies/)
        try {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            cv.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
            cv.put(MediaStore.MediaColumns.RELATIVE_PATH, fallbackDir);
            Uri uri = resolver.insert(collection, cv);
            if (uri != null) return uri;
        } catch (Throwable t) {
            Log.w(TAG, "MediaStore insert 3 failed: " + t.getMessage());
        }

        // Try 4: Downloads collection (universal across all Android 10+ devices)
        try {
            ContentValues cv = new ContentValues();
            cv.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            cv.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
            cv.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/FreeColor/");
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (uri != null) return uri;
        } catch (Throwable t) {
            Log.w(TAG, "MediaStore insert 4 failed: " + t.getMessage());
        }

        return null;
    }

    @PluginMethod
    public void saveImageToGallery(PluginCall call) {
        String base64Data = call.getString("base64");
        if (base64Data == null || base64Data.trim().isEmpty()) {
            base64Data = call.getString("base64Data");
        }
        String filename = call.getString("filename");
        if (filename == null || filename.trim().isEmpty()) {
            filename = call.getString("fileName");
        }
        if (filename == null || filename.trim().isEmpty()) {
            filename = "FreeColor_" + System.currentTimeMillis() + ".jpg";
        }

        if (base64Data == null || base64Data.trim().isEmpty()) {
            call.reject("Data file tidak boleh kosong");
            return;
        }

        try {
            if (base64Data.contains(",")) {
                base64Data = base64Data.substring(base64Data.indexOf(",") + 1);
            }

            byte[] decoded = Base64.decode(base64Data, Base64.DEFAULT);
            if (decoded == null || decoded.length == 0) {
                call.reject("Gagal memproses data media");
                return;
            }

            String lower = filename.toLowerCase();
            boolean isVideo = lower.endsWith(".mp4") || lower.endsWith(".mov") || lower.endsWith(".m4v");
            boolean isWebP = lower.endsWith(".webp");
            boolean isPng = lower.endsWith(".png");

            String mimeType = isVideo ? "video/mp4" : (isWebP ? "image/webp" : (isPng ? "image/png" : "image/jpeg"));

            long nowMs = System.currentTimeMillis();
            long nowSec = nowMs / 1000;

            OutputStream fos = null;
            Uri mediaUri = null;
            File savedFile = null;
            boolean savedViaMediaStore = false;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    ContentResolver resolver = getContext().getContentResolver();
                    mediaUri = createMediaStoreUri(resolver, filename, mimeType, isVideo, nowSec, nowMs);

                    if (mediaUri != null) {
                        fos = resolver.openOutputStream(mediaUri);
                        if (fos != null) {
                            fos.write(decoded);
                            fos.flush();
                            fos.close();
                            fos = null;
                        }

                        try {
                            ContentValues cv = new ContentValues();
                            cv.put(MediaStore.MediaColumns.IS_PENDING, 0);
                            resolver.update(mediaUri, cv, null, null);
                        } catch (Throwable ignored) {}

                        try {
                            resolver.notifyChange(mediaUri, null);
                        } catch (Throwable ignored) {}

                        try {
                            Intent scanIntent = new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, mediaUri);
                            getContext().sendBroadcast(scanIntent);
                        } catch (Throwable ignored) {}

                        savedViaMediaStore = true;
                    }
                } catch (Exception qEx) {
                    Log.e(TAG, "MediaStore write failed: ", qEx);
                    savedViaMediaStore = false;
                }
            }

            if (!savedViaMediaStore) {
                File targetDir = isVideo
                    ? Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES)
                    : Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES);
                File freeColorDir = new File(targetDir, "FreeColor");
                if (!freeColorDir.exists()) {
                    freeColorDir.mkdirs();
                }

                savedFile = new File(freeColorDir, filename);
                fos = new FileOutputStream(savedFile);
                fos.write(decoded);
                fos.flush();
                fos.close();
                fos = null;

                MediaScannerConnection.scanFile(
                    getContext(),
                    new String[]{savedFile.getAbsolutePath()},
                    new String[]{mimeType},
                    null
                );

                try {
                    Intent scanIntent = new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE);
                    scanIntent.setData(Uri.fromFile(savedFile));
                    getContext().sendBroadcast(scanIntent);
                } catch (Throwable ignored) {}
            }

            JSObject result = new JSObject();
            result.put("success", true);
            result.put("filename", filename);
            result.put("album", isVideo ? "Movies/FreeColor" : "Pictures/FreeColor");
            result.put("sizeBytes", decoded.length);
            result.put("message", "Tersimpan di Galeri album 'FreeColor'!");
            call.resolve(result);

        } catch (Exception e) {
            Log.e(TAG, "saveImageToGallery exception: ", e);
            call.reject("Gagal menyimpan ke galeri HP: " + e.getMessage());
        }
    }

    @PluginMethod
    public void writeMediaChunk(PluginCall call) {
        String sessionId = call.getString("sessionId");
        String chunk = call.getString("chunk");
        String filename = call.getString("filename", "FreeColor_" + System.currentTimeMillis() + ".mp4");
        boolean isFirst = call.getBoolean("isFirst", false);
        boolean isLast = call.getBoolean("isLast", false);

        if (sessionId == null || sessionId.trim().isEmpty()) {
            call.reject("sessionId wajib diisi");
            return;
        }

        try {
            SessionData session = activeSessions.get(sessionId);
            if (isFirst || session == null) {
                if (session != null && session.fos != null) {
                    try { session.fos.close(); } catch (Throwable ignored) {}
                }
                session = new SessionData();
                session.filename = filename;
                String lower = filename.toLowerCase();
                session.isVideo = lower.endsWith(".mp4") || lower.endsWith(".mov") || lower.endsWith(".m4v");
                boolean isWebP = lower.endsWith(".webp");
                boolean isPng = lower.endsWith(".png");
                session.mimeType = session.isVideo ? "video/mp4" : (isWebP ? "image/webp" : (isPng ? "image/png" : "image/jpeg"));

                long nowMs = System.currentTimeMillis();
                session.nowSec = nowMs / 1000;
                session.totalBytes = 0;

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    try {
                        ContentResolver resolver = getContext().getContentResolver();
                        session.mediaUri = createMediaStoreUri(resolver, filename, session.mimeType, session.isVideo, session.nowSec, nowMs);

                        if (session.mediaUri != null) {
                            session.fos = resolver.openOutputStream(session.mediaUri);
                            session.savedViaMediaStore = true;
                        }
                    } catch (Exception e) {
                        Log.e(TAG, "writeMediaChunk initial MediaStore failed: ", e);
                        session.savedViaMediaStore = false;
                    }
                }

                if (!session.savedViaMediaStore) {
                    File targetDir = session.isVideo
                        ? Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES)
                        : Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES);
                    File freeColorDir = new File(targetDir, "FreeColor");
                    if (!freeColorDir.exists()) {
                        freeColorDir.mkdirs();
                    }
                    session.savedFile = new File(freeColorDir, filename);
                    session.fos = new FileOutputStream(session.savedFile);
                }

                activeSessions.put(sessionId, session);
            }

            if (chunk != null && !chunk.isEmpty()) {
                if (chunk.contains(",")) {
                    chunk = chunk.substring(chunk.indexOf(",") + 1);
                }
                byte[] decoded = Base64.decode(chunk, Base64.DEFAULT);
                if (decoded != null && decoded.length > 0 && session.fos != null) {
                    session.fos.write(decoded);
                    session.totalBytes += decoded.length;
                }
            }

            if (isLast) {
                if (session.fos != null) {
                    session.fos.flush();
                    session.fos.close();
                    session.fos = null;
                }

                if (session.savedViaMediaStore && session.mediaUri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    try {
                        ContentResolver resolver = getContext().getContentResolver();
                        ContentValues contentValues = new ContentValues();
                        contentValues.put(MediaStore.MediaColumns.IS_PENDING, 0);
                        resolver.update(session.mediaUri, contentValues, null, null);
                        resolver.notifyChange(session.mediaUri, null);

                        Intent scanIntent = new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, session.mediaUri);
                        getContext().sendBroadcast(scanIntent);
                    } catch (Throwable ignored) {}
                } else if (session.savedFile != null) {
                    MediaScannerConnection.scanFile(
                        getContext(),
                        new String[]{session.savedFile.getAbsolutePath()},
                        new String[]{session.mimeType},
                        null
                    );
                    try {
                        Intent scanIntent = new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE);
                        scanIntent.setData(Uri.fromFile(session.savedFile));
                        getContext().sendBroadcast(scanIntent);
                    } catch (Throwable ignored) {}
                }

                activeSessions.remove(sessionId);

                JSObject result = new JSObject();
                result.put("success", true);
                result.put("filename", filename);
                result.put("album", session.isVideo ? "Movies/FreeColor" : "Pictures/FreeColor");
                result.put("sizeBytes", session.totalBytes);
                result.put("message", "Tersimpan di Galeri album 'FreeColor'!");
                call.resolve(result);
                return;
            }

            JSObject progress = new JSObject();
            progress.put("success", true);
            progress.put("receivedBytes", session.totalBytes);
            call.resolve(progress);

        } catch (Exception e) {
            Log.e(TAG, "writeMediaChunk exception: ", e);
            activeSessions.remove(sessionId);
            call.reject("Gagal menulis file ke galeri: " + e.getMessage());
        }
    }
}
