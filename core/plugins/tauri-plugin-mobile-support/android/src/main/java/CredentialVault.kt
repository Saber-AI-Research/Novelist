package com.novelist.mobilesupport

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Secrets encrypted with a non-exportable AES-256-GCM Android Keystore key
 * and stored only as ciphertext in app-private SharedPreferences.
 *
 * Stored value: base64(version || iv(12) || ciphertext+tag). The Keystore
 * generates a fresh random IV for every write, and the entry name is bound as
 * AAD so ciphertexts cannot be swapped between entries. Nothing here logs,
 * and every failure surfaces as an exception the caller turns into an opaque
 * rejection. Not thread-safe: MobileSupportPlugin serializes calls on one
 * worker thread.
 */
internal class CredentialVault(context: Context) {
  private val prefs: SharedPreferences =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  fun get(service: String, account: String): String? {
    val name = entryName(service, account)
    val stored = prefs.getString(name, null) ?: return null
    val key = existingKey()
    if (key == null) {
      // Ciphertext without its Keystore key (restored or device-transferred
      // data) can never be decrypted: drop it and report "missing".
      clearOrphanedEntries()
      return null
    }
    val blob = Base64.decode(stored, Base64.NO_WRAP)
    require(blob.size > HEADER_BYTES && blob[0] == FORMAT_VERSION)
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, blob, 1, IV_BYTES))
    cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
    val plain = cipher.doFinal(blob, HEADER_BYTES, blob.size - HEADER_BYTES)
    try {
      return String(plain, Charsets.UTF_8)
    } finally {
      plain.fill(0)
    }
  }

  fun set(service: String, account: String, secret: String) {
    val name = entryName(service, account)
    val key = existingKey() ?: run {
      clearOrphanedEntries()
      createKey()
    }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    // No IV supplied: randomized encryption is required, the Keystore picks it.
    cipher.init(Cipher.ENCRYPT_MODE, key)
    cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
    val plain = secret.toByteArray(Charsets.UTF_8)
    val sealed = try {
      cipher.doFinal(plain)
    } finally {
      plain.fill(0)
    }
    val iv = cipher.iv
    check(iv.size == IV_BYTES)
    val blob = ByteArray(HEADER_BYTES + sealed.size)
    blob[0] = FORMAT_VERSION
    System.arraycopy(iv, 0, blob, 1, IV_BYTES)
    System.arraycopy(sealed, 0, blob, HEADER_BYTES, sealed.size)
    check(prefs.edit().putString(name, Base64.encodeToString(blob, Base64.NO_WRAP)).commit())
  }

  fun delete(service: String, account: String) {
    check(prefs.edit().remove(entryName(service, account)).commit())
  }

  private fun clearOrphanedEntries() {
    if (prefs.all.isNotEmpty()) {
      check(prefs.edit().clear().commit())
    }
  }

  private fun existingKey(): SecretKey? {
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    return keyStore.getKey(KEY_ALIAS, null) as SecretKey?
  }

  private fun createKey(): SecretKey {
    val spec = KeyGenParameterSpec.Builder(
      KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setRandomizedEncryptionRequired(true)
      .build()
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    generator.init(spec)
    return generator.generateKey()
  }

  companion object {
    private const val PREFS_NAME = "novelist_mobile_support_vault"
    private const val KEY_ALIAS = "novelist.mobile-support.vault.v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val HEADER_BYTES = 1 + IV_BYTES
    private const val TAG_BITS = 128
    private const val FORMAT_VERSION: Byte = 1

    /** Unambiguous for any strings: base64url never contains ':'. */
    private fun entryName(service: String, account: String): String {
      val flags = Base64.NO_WRAP or Base64.URL_SAFE or Base64.NO_PADDING
      return "v1:" +
        Base64.encodeToString(service.toByteArray(Charsets.UTF_8), flags) + ":" +
        Base64.encodeToString(account.toByteArray(Charsets.UTF_8), flags)
    }
  }
}
