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
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

@CapacitorPlugin(name = "FreeColorGallery")
public class FreeColorGalleryPlugin extends Plugin {

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
            String relativeDir = isVideo ? (Environment.DIRECTORY_MOVIES + File.separator + "FreeColor") : (Environment.DIRECTORY_PICTURES + File.separator + "FreeColor");

            long nowMs = System.currentTimeMillis();
            long nowSec = nowMs / 1000;

            OutputStream fos = null;
            Uri mediaUri = null;
            File savedFile = null;
            boolean savedViaMediaStore = false;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    ContentResolver resolver = getContext().getContentResolver();
                    ContentValues contentValues = new ContentValues();
                    contentValues.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                    contentValues.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                    contentValues.put(MediaStore.MediaColumns.RELATIVE_PATH, relativeDir);
                    contentValues.put(MediaStore.MediaColumns.DATE_ADDED, nowSec);
                    contentValues.put(MediaStore.MediaColumns.DATE_MODIFIED, nowSec);
                    contentValues.put(MediaStore.MediaColumns.IS_PENDING, 1);

                    Uri collection = isVideo ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                    if (!isVideo) {
                        contentValues.put(MediaStore.Images.Media.DATE_TAKEN, nowMs);
                    }

                    mediaUri = resolver.insert(collection, contentValues);
                    if (mediaUri != null) {
                        fos = resolver.openOutputStream(mediaUri);
                        if (fos != null) {
                            fos.write(decoded);
                            fos.flush();
                            fos.close();
                            fos = null;
                        }
                        contentValues.clear();
                        contentValues.put(MediaStore.MediaColumns.IS_PENDING, 0);
                        resolver.update(mediaUri, contentValues, null, null);

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
                    savedViaMediaStore = false;
                }
            }

            if (!savedViaMediaStore) {
                File targetDir = isVideo ? Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES) : Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES);
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
            call.reject("Gagal menyimpan ke galeri HP: " + e.getMessage());
        }
    }
}
