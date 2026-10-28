package com.novelist.app

import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // One native inset authority: keep the WebView clear of bars, cutouts and
    // the IME. Consuming them prevents a second padding pass inside WebView.
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val safe = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(safe.left, safe.top, safe.right, maxOf(safe.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(root)
  }

  // System Back first closes the top-most web layer (palette, dialog, sheet,
  // drawer) via `window.__novelistBack()`; only when nothing is open does it
  // fall through to the default behaviour (leave the app).
  override fun onWebViewCreate(webView: WebView) {
    val callback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript("window.__novelistBack ? window.__novelistBack() : false") { result ->
          if (result == "true") return@evaluateJavascript
          isEnabled = false
          onBackPressedDispatcher.onBackPressed()
          isEnabled = true
        }
      }
    }
    onBackPressedDispatcher.addCallback(this, callback)
  }
}
