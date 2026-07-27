const DB_NAME = 'bk-source-preview-store'
const DB_VERSION = 1
const STORE_NAME = 'source-files'

type StoredSourceFile = {
  fingerprint: string
  blob: Blob
  fileName: string
  fileType: string
  lastModified: number
}

const openDatabase = async (): Promise<IDBDatabase | null> => {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return null

  return new Promise((resolve) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => resolve(null)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'fingerprint' })
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

const runWrite = async (
  mode: IDBTransactionMode,
  handler: (store: IDBObjectStore, done: () => void, fail: () => void) => void,
) => {
  const database = await openDatabase()
  if (!database) return false

  return new Promise<boolean>((resolve) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const store = transaction.objectStore(STORE_NAME)
    let settled = false

    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    transaction.oncomplete = () => {
      database.close()
      finish(true)
    }
    transaction.onerror = () => {
      database.close()
      finish(false)
    }
    transaction.onabort = () => {
      database.close()
      finish(false)
    }

    handler(store, () => finish(true), () => finish(false))
  })
}

export const saveSourcePreviewFile = async (fingerprint: string, file: File) => {
  if (!fingerprint) return false
  return runWrite('readwrite', (store) => {
    const record: StoredSourceFile = {
      fingerprint,
      blob: file,
      fileName: file.name,
      fileType: file.type || 'application/octet-stream',
      lastModified: file.lastModified,
    }
    store.put(record)
  })
}

export const loadSourcePreviewFile = async (fingerprint: string): Promise<File | null> => {
  if (!fingerprint) return null
  const database = await openDatabase()
  if (!database) return null

  return new Promise<File | null>((resolve) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.get(fingerprint)

    request.onerror = () => {
      database.close()
      resolve(null)
    }
    request.onsuccess = () => {
      const record = request.result as StoredSourceFile | undefined
      database.close()
      if (!record?.blob) {
        resolve(null)
        return
      }
      resolve(
        new File([record.blob], record.fileName, {
          type: record.fileType,
          lastModified: record.lastModified || Date.now(),
        }),
      )
    }
  })
}

export const deleteSourcePreviewFile = async (fingerprint: string) => {
  if (!fingerprint) return false
  return runWrite('readwrite', (store) => {
    store.delete(fingerprint)
  })
}

export const clearSourcePreviewStore = async () => runWrite('readwrite', (store) => {
  store.clear()
})
