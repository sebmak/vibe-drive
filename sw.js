const CACHE_NAME = 'drive-clone-v1';
const DB_NAME = 'DriveCacheDB';
const DB_VERSION = 2;
const STORE_NAME = 'files';
const META_STORE = 'metadata';

// --- IndexedDB Wrapper ---
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => {
            console.error('[SW] IndexedDB open error:', request.error);
            reject(request.error);
        };
        request.onblocked = () => {
            console.warn('[SW] IndexedDB upgrade blocked. Please close other tabs.');
        };
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                // We use 'id' as the key
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                // Index to quickly find files by their parent folder
                store.createIndex('parents', 'parents', { multiEntry: true });
            }
            if (!db.objectStoreNames.contains(META_STORE)) {
                db.createObjectStore(META_STORE, { keyPath: 'key' });
            }
        };
    });
}

async function getMetadata(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(META_STORE, 'readonly');
        const store = transaction.objectStore(META_STORE);
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result ? request.result.value : null);
        request.onerror = () => reject(request.error);
    });
}

async function saveMetadata(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(META_STORE, 'readwrite');
        const store = transaction.objectStore(META_STORE);
        store.put({ key, value });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

async function getFilesByParent(parentId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('parents');
        const request = index.getAll(parentId);

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

async function saveFiles(files) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        files.forEach(file => {
            // Ensure parents array exists for the index
            if (!file.parents) file.parents = ['root'];
            store.put(file);
        });

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/styles.css',
    '/app.js',
    '/api.js',
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

// Install event
self.addEventListener('install', (event) => {
    console.log('[Service Worker] Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[Service Worker] Caching static assets');
            return cache.addAll(ASSETS_TO_CACHE);
        }).then(() => {
            console.log('[Service Worker] Static assets cached successfully.');
            return self.skipWaiting();
        }).catch(err => {
            console.error('[SW] Failed to cache static assets during install:', err);
            // Force skipWaiting so the SW still installs even if an asset (like a font) fails to download
            return self.skipWaiting();
        })
    );
});

// Activate event
self.addEventListener('activate', (event) => {
    console.log('[Service Worker] Activating...');
    event.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(keyList.map((key) => {
                if (key !== CACHE_NAME) {
                    console.log('[Service Worker] Removing old cache', key);
                    return caches.delete(key);
                }
            }));
        }).then(() => clients.claim())
    );
});

// Fetch event - Stale-While-Revalidate pattern for API
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Only intercept Drive API files list endpoint
    if (url.hostname.includes('googleapis.com') && url.pathname.includes('/drive/v3/files')) {
        
        // 1. Try to determine the parent folder from the 'q' parameter
        const qParam = url.searchParams.get('q') || '';
        const parentMatch = qParam.match(/'([^']+)'\s+in\s+parents/);
        const parentId = parentMatch ? parentMatch[1] : null;

        if (parentId) {
            event.respondWith((async () => {
                let cachedFiles = [];
                let hasCache = false;

                let actualParentId = parentId;
                if (parentId === 'root') {
                    const cachedRootId = await getMetadata('rootId');
                    if (cachedRootId) {
                        actualParentId = cachedRootId;
                    }
                }

                try {
                    // 2. Fetch from IndexedDB Cache
                    cachedFiles = await getFilesByParent(actualParentId);
                    if (cachedFiles && cachedFiles.length > 0) {
                        hasCache = true;
                    }
                } catch (err) {
                    console.error('[SW] DB Read Error', err);
                }

                // 3. Initiate Network Fetch
                const networkPromise = fetch(event.request).then(async (networkResponse) => {
                    if (!networkResponse.ok) return networkResponse;

                    // Clone the response so we can read the JSON and also return it
                    const responseClone = networkResponse.clone();
                    try {
                        const data = await responseClone.json();
                        if (data && data.files) {
                            // 4. Update the IndexedDB Cache
                            try {
                                await saveFiles(data.files);
                                console.log(`[SW] Successfully cached ${data.files.length} items to IndexedDB.`);
                            } catch (dbErr) {
                                console.error('[SW] Failed to cache items:', dbErr);
                            }
                            
                            // 5. Diff & Notify UI (if we served stale cache)
                            if (hasCache) {
                                // Basic diff logic: just check if length changed or first item changed
                                // For a real app, you'd do a deep comparison or check modifiedTime
                                const isDiff = data.files.length !== cachedFiles.length || 
                                               (data.files[0] && cachedFiles[0] && data.files[0].id !== cachedFiles[0].id);
                                
                                if (isDiff) {
                                    console.log('[SW] Network data differs from cache, notifying clients...');
                                    const allClients = await clients.matchAll();
                                    for (const client of allClients) {
                                        client.postMessage({
                                            type: 'DRIVE_DATA_UPDATED',
                                            files: data.files
                                        });
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.error('[SW] Error parsing/saving network response', e);
                    }
                    return networkResponse;
                }).catch(err => {
                    console.log(`[SW] Network fetch failed for ${url.pathname} (offline).`);
                    // If network fails and we have no cache, return a 503 instead of throwing
                    if (!hasCache) {
                        return new Response(JSON.stringify({ files: [] }), {
                            status: 503,
                            statusText: 'Service Unavailable (Offline)',
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                });

                // 6. Respond immediately with Cache (if available), otherwise wait for Network
                if (hasCache) {
                    console.log(`[SW] Serving ${cachedFiles.length} files from Cache for parent: ${actualParentId}`);
                    // Construct a mock HTTP response that the Google API client expects
                    const mockBody = JSON.stringify({ files: cachedFiles });
                    return new Response(mockBody, {
                        headers: { 'Content-Type': 'application/json' },
                        status: 200
                    });
                } else {
                    console.log(`[SW] No cache for ${actualParentId}, waiting for network...`);
                    return networkPromise;
                }
            })());

            // 7. Fire off background fetch for root ID if querying root
            if (parentId === 'root') {
                const authHeader = event.request.headers.get('Authorization');
                if (authHeader) {
                    fetch('https://www.googleapis.com/drive/v3/files/root?fields=id', {
                        headers: { 'Authorization': authHeader }
                    }).then(r => r.json()).then(data => {
                        if (data && data.id) saveMetadata('rootId', data.id);
                    }).catch(e => console.log('[SW] Failed to sync root ID', e));
                }
            }
            
            return; // We handled it
        }
    }

    // Pass through all other requests with Cache-First strategy
    event.respondWith(
        caches.match(event.request, { ignoreSearch: url.pathname.includes('/discovery/') }).then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse;
            }
            return fetch(event.request).then((networkResponse) => {
                // Dynamically cache discovery documents
                if (url.hostname.includes('googleapis.com') && url.pathname.includes('/discovery/')) {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return networkResponse;
            }).catch(() => {
                console.log(`[SW] Network fetch failed for ${url.pathname} (offline). Returning dummy response.`);
                // If offline and not in cache, return a dummy response to prevent unhandled fetch errors
                if (url.hostname.includes('googleapis.com')) {
                    return new Response(JSON.stringify({}), {
                        status: 503,
                        statusText: 'Service Unavailable (Offline)',
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                
                // Always return a Response object to prevent "Failed to convert value to 'Response'"
                return new Response('Offline', {
                    status: 503,
                    statusText: 'Service Unavailable (Offline)'
                });
            });
        })
    );
});
