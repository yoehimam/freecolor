package id.freecolor.underwater;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
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
            // Remove data URI prefix if present
            if (base64Data.contains(",")) {
                base64Data = base64Data.substring(base64Data.indexOf(",") + 1);
            }

            byte[] decoded = Base64.decode(base64Data, Base64.DEFAULT);
            Bitmap bitmap = BitmapFactory.decodeByteArray(decoded, 0, decoded.length);

            if (bitmap == null) {
                call.reject("Gagal membaca data gambar bitmap");
                return;
            }

            OutputStream fos = null;
            Uri imageUri = null;
            File savedFile = null;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Android 10+ (API 29+): MediaStore Scoped Storage directly into Pictures/FreeColor
                ContentResolver resolver = getContext().getContentResolver();
                ContentValues contentValues = new ContentValues();
                contentValues.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                contentValues.put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg");
                contentValues.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + File.separator + "FreeColor");
                contentValues.put(MediaStore.MediaColumns.IS_PENDING, 1);

                imageUri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, contentValues);
                if (imageUri != null) {
                    fos = resolver.openOutputStream(imageUri);
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 92, fos);
                    if (fos != null) {
                        fos.flush();
                        fos.close();
                    }
                    contentValues.clear();
                    contentValues.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    resolver.update(imageUri, contentValues, null, null);
                } else {
                    call.reject("Gagal membuat entri di MediaStore Android");
                    return;
                }
            } else {
                // Android 9 and below: Direct public Pictures directory
                File picturesDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES);
                File freeColorDir = new File(picturesDir, "FreeColor");
                if (!freeColorDir.exists()) {
                    freeColorDir.mkdirs();
                }

                savedFile = new File(freeColorDir, filename);
                fos = new FileOutputStream(savedFile);
                bitmap.compress(Bitmap.CompressFormat.JPEG, 92, fos);
                fos.flush();
                fos.close();

                // Force MediaScanner to broadcast to phone Gallery immediately
                MediaScannerConnection.scanFile(
                    getContext(),
                    new String[]{savedFile.getAbsolutePath()},
                    new String[]{"image/jpeg"},
                    null
                );
            }

            JSObject result = new JSObject();
            result.put("success", true);
            result.put("filename", filename);
            result.put("album", "Pictures/FreeColor");
            result.put("message", "Foto tersimpan di Galeri album 'FreeColor'!");
            call.resolve(result);

        } catch (Exception e) {
            call.reject("Gagal menyimpan ke galeri HP: " + e.getMessage());
        }
    }
}
