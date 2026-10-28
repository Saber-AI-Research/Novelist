package com.novelist.mobilesupport

import androidx.core.content.FileProvider

/**
 * Distinct subclass so the manifest merger keeps this provider separate from
 * the app's own `androidx.core.content.FileProvider` entry.
 */
class ShareFileProvider : FileProvider()
