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
        String filename = call.getString("filename");
        if (filename == null || filename.trim().isEmpty()) {
            filename = "FreeColor_" + System.currentTimeMillis() + ".jpg";
        }
        if (!filename.toLowerCase().endsWith(".jpg") && !filename.toLowerCase().endsWith(".jpeg") && !filename.toLowerCase().endsWith(".webp")) {
            filename = filename + ".jpg";
        }

        if (base64Data == null || base64Data.trim().isEmpty()) {
            call.reject("Data gambar tidak boleh kosong");
            return;
        }

        try {
            // Remove data URI prefix if present (e.g. data:image/jpeg;base64,)
            if (base64Data.contains(",")) {
                base64Data = base64Data.substring(base64Data.indexOf(",") + 1);
            }

            // Decode directly into image file bytes (zero extra bitmap allocation to guarantee smooth performance on all phones)
            byte[] decoded = Base64.decode(base64Data, Base64.DEFAULT);
            if (decoded == null || decoded.length == 0) {
                call.reject("Gagal memproses data gambar");
                return;
            }

            boolean isWebP = filename.toLowerCase().endsWith(".webp");
            String mimeType = isWebP ? "image/webp" : "image/jpeg";
            long nowMs = System.currentTimeMillis();
            long nowSec = nowMs / 1000;

            OutputStream fos = null;
            Uri imageUri = null;
            File savedFile = null;
            boolean savedViaMediaStore = false;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    // Android 10+ (API 29+): MediaStore Scoped Storage directly into Pictures/FreeColor
                    ContentResolver resolver = getContext().getContentResolver();
                    ContentValues contentValues = new ContentValues();
                    contentValues.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                    contentValues.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                    contentValues.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + File.separator + "FreeColor");
                    // Essential date fields so phone gallery immediately displays it on top of "Photos" / "Recents"
                    contentValues.put(MediaStore.Images.Media.DATE_TAKEN, nowMs);
                    contentValues.put(MediaStore.MediaColumns.DATE_ADDED, nowSec);
                    contentValues.put(MediaStore.MediaColumns.DATE_MODIFIED, nowSec);
                    contentValues.put(MediaStore.MediaColumns.IS_PENDING, 1);

                    imageUri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, contentValues);
                    if (imageUri != null) {
                        fos = resolver.openOutputStream(imageUri);
                        if (fos != null) {
                            fos.write(decoded);
                            fos.flush();
                            fos.close();
                            fos = null;
                        }
                        contentValues.clear();
                        contentValues.put(MediaStore.MediaColumns.IS_PENDING, 0);
                        resolver.update(imageUri, contentValues, null, null);

                        try {
                            resolver.notifyChange(imageUri, null);
                        } catch (Throwable ignored) {}

                        try {
                            Intent scanIntent = new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, imageUri);
                            getContext().sendBroadcast(scanIntent);
                        } catch (Throwable ignored) {}

                        savedViaMediaStore = true;
                    }
                } catch (Exception qEx) {
                    savedViaMediaStore = false;
                }
            }

            // Fallback for Android 9 or if MediaStore insert failed
            if (!savedViaMediaStore) {
                File picturesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES);
                File freeColorDir = new File(picturesDir, "FreeColor");
                if (!freeColorDir.exists()) {
                    freeColorDir.mkdirs();
                }

                savedFile = new File(freeColorDir, filename);
                fos = new FileOutputStream(savedFile);
                fos.write(decoded);
                fos.flush();
                fos.close();
                fos = null;

                // Force MediaScanner to broadcast to phone Gallery immediately
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
            result.put("album", "Pictures/FreeColor");
            result.put("sizeBytes", decoded.length);
            result.put("message", "Foto tersimpan di Galeri album 'FreeColor'!");
            call.resolve(result);

        } catch (Exception e) {
            call.reject("Gagal menyimpan ke galeri HP: " + e.getMessage());
        }
    }
}
