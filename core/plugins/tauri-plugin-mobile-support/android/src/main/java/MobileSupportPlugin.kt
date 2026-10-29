package com.novelist.mobilesupport

import android.app.Activity
import android.content.ClipData
import android.content.ClipDescription
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

@InvokeArg
class ShareFileArgs {
  lateinit var path: String
  lateinit var mimeType: String
}

@InvokeArg
class CredentialKeyArgs {
  lateinit var service: String
  lateinit var account: String
}

@InvokeArg
class CredentialEntryArgs {
  lateinit var service: String
  lateinit var account: String
  lateinit var secret: String
}

/**
 * Native half of tauri-plugin-mobile-support. Every command here is reached
 * only from the plugin's Rust code (none is in the webview ACL); Rust has
 * already validated paths, MIME types and vault bounds.
 */
@TauriPlugin
class MobileSupportPlugin(private val activity: Activity) : Plugin(activity) {
  private val vault = CredentialVault(activity.applicationContext)
  private val vaultExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private val mainHandler = Handler(Looper.getMainLooper())

  // UI-thread state: Tauri dispatches Android commands and activity results there.
  private var pendingShare: Invoke? = null
  private var pausedDuringShare = false

  @Command
  fun shareFile(invoke: Invoke) {
    if (pendingShare != null) {
      invoke.reject("a share sheet is already open")
      return
    }
    val send = try {
      shareIntent(invoke.parseArgs(ShareFileArgs::class.java))
    } catch (e: Exception) {
      null
    }
    if (send == null) {
      invoke.reject("file is not a staged export")
      return
    }
    // createChooser carries the grant flag and ClipData over to the chooser intent.
    val chooser = Intent.createChooser(send, null)

    pendingShare = invoke
    pausedDuringShare = false
    try {
      startActivityForResult(invoke, chooser, "shareResult")
    } catch (e: Exception) {
      pendingShare = null
      invoke.reject("could not open the share sheet")
    }
  }

  /**
   * The chooser reports RESULT_CANCELED whether or not a target was picked,
   * so the honest outcome is "dismissed", never "shared".
   */
  @ActivityCallback
  fun shareResult(invoke: Invoke, @Suppress("UNUSED_PARAMETER") result: ActivityResult) {
    finishShare(invoke)
  }

  override fun onPause() {
    if (pendingShare != null) {
      pausedDuringShare = true
    }
  }

  override fun onResume() {
    val invoke = pendingShare ?: return
    if (!pausedDuringShare) {
      return
    }
    // Activity results are delivered before onResume. If none arrived, the
    // result callback was lost (Tauri keeps a single launcher callback);
    // resolve instead of blocking every later share.
    mainHandler.post { finishShare(invoke) }
  }

  override fun onDestroy() {
    vaultExecutor.shutdown()
  }

  @Command
  fun getCredential(invoke: Invoke) {
    runVault(invoke) {
      val args = invoke.parseArgs(CredentialKeyArgs::class.java)
      val ret = JSObject()
      vault.get(args.service, args.account)?.let { ret.put("value", it) }
      invoke.resolve(ret)
    }
  }

  @Command
  fun setCredential(invoke: Invoke) {
    runVault(invoke) {
      val args = invoke.parseArgs(CredentialEntryArgs::class.java)
      vault.set(args.service, args.account, args.secret)
      invoke.resolve()
    }
  }

  @Command
  fun deleteCredential(invoke: Invoke) {
    runVault(invoke) {
      val args = invoke.parseArgs(CredentialKeyArgs::class.java)
      vault.delete(args.service, args.account)
      invoke.resolve()
    }
  }

  private fun finishShare(invoke: Invoke) {
    if (pendingShare !== invoke) {
      return
    }
    pendingShare = null
    val ret = JSObject()
    ret.put("outcome", "dismissed")
    invoke.resolve(ret)
  }

  /**
   * ACTION_SEND for a canonical regular file strictly inside cacheDir/exports,
   * else null. Re-checks the Rust validation; the provider checks again on open.
   */
  private fun shareIntent(args: ShareFileArgs): Intent? {
    val root = File(activity.cacheDir, EXPORTS_DIR).canonicalFile
    val file = File(args.path).canonicalFile
    if (!file.path.startsWith(root.path + File.separator) || !file.isFile) {
      return null
    }
    // Throws if the file is outside the provider's cache/exports root.
    val uri = FileProvider.getUriForFile(activity, activity.packageName + AUTHORITY_SUFFIX, file)
    return Intent(Intent.ACTION_SEND).apply {
      type = args.mimeType
      putExtra(Intent.EXTRA_STREAM, uri)
      clipData = ClipData(ClipDescription(file.name, arrayOf(args.mimeType)), ClipData.Item(uri))
      // Temporary, read-only grant scoped to the receiving activity; never persisted.
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
  }

  /**
   * Keystore work runs off the UI thread, serialized on one worker. Failures
   * are rejected with a fixed message and no exception, so nothing reaches
   * the log (Invoke.reject logs any exception it is given).
   */
  private fun runVault(invoke: Invoke, block: () -> Unit) {
    try {
      vaultExecutor.execute {
        try {
          block()
        } catch (e: Exception) {
          invoke.reject(VAULT_FAILURE)
        }
      }
    } catch (e: Exception) {
      invoke.reject(VAULT_FAILURE)
    }
  }

  companion object {
    /** Must match SHARE_STAGING_DIR_NAME in src/lib.rs and res/xml/mobile_support_share_paths.xml. */
    private const val EXPORTS_DIR = "exports"
    /** Must match android:authorities in AndroidManifest.xml. */
    private const val AUTHORITY_SUFFIX = ".mobilesupport.share"
    private const val VAULT_FAILURE = "credential vault operation failed"
  }
}
