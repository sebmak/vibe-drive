/**
 * CloudApiService
 * Uses the real Google Drive API and Google Identity Services.
 */

// TODO: Replace these with your actual OAuth 2.0 Client ID from the Google Cloud Console
const CLIENT_ID = '822855827589-mno7tvuhhodhkoot6032q5jmhjenu3hs.apps.googleusercontent.com';

// Discovery doc URL for APIs used by the quickstart
const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';

// Authorization scopes required by the API
const SCOPES = 'https://www.googleapis.com/auth/drive.metadata.readonly';

class CloudApiService {
    constructor() {
        this.tokenClient = null;
        this.gapiInited = false;
        this.gisInited = false;

        // Wait for both scripts to load before enabling auth
        this.onLoadCallback = null;
    }

    init(onLoadCallback) {
        this.onLoadCallback = onLoadCallback;

        // Load gapi script
        if (typeof gapi !== 'undefined') {
            gapi.load('client', this.initializeGapiClient.bind(this));
        } else {
            console.error('gapi script not loaded');
        }

        // Load gis script
        if (typeof google !== 'undefined') {
            this.gisLoaded();
        } else {
            console.error('Google Identity Services script not loaded');
        }
    }

    async initializeGapiClient() {
        try {
            await gapi.client.init({
                discoveryDocs: [DISCOVERY_DOC],
            });
        } catch (error) {
            console.error('Error initializing GAPI client, ignoring for offline support', error);
        } finally {
            this.gapiInited = true;
            this.maybeEnableButtons();
        }
    }

    gisLoaded() {
        if (CLIENT_ID === 'YOUR_CLIENT_ID_HERE') {
            return;
        }

        this.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPES,
            callback: '', // defined later
        });
        this.gisInited = true;
        this.maybeEnableButtons();
    }

    maybeEnableButtons() {
        if (this.gapiInited && this.gisInited && this.onLoadCallback) {
            this.onLoadCallback();
        }
    }

    handleAuthClick(callback) {
        if (!this.tokenClient) {
            alert('OAuth credentials not configured. Please add CLIENT_ID and API_KEY in api.js');
            return;
        }

        this.tokenClient.callback = async (resp) => {
            if (resp.error !== undefined) {
                throw (resp);
            }

            // Save token and calculate expiry (subtract 5 seconds for buffer)
            const expiresAt = Date.now() + ((resp.expires_in - 5) * 1000);
            localStorage.setItem('drive_oauth_token', JSON.stringify({
                access_token: resp.access_token,
                expiresAt: expiresAt
            }));

            if (callback) callback();
        };

        if (gapi.client.getToken() === null) {
            // Prompt the user to select a Google Account and ask for consent to share their data
            // when establishing a new session.
            this.tokenClient.requestAccessToken({ prompt: 'consent' });
        } else {
            // Skip display of account chooser and consent dialog for an existing session.
            this.tokenClient.requestAccessToken({ prompt: '' });
        }
    }

    /**
     * Tries to restore a valid token from localStorage.
     * @returns {boolean} True if a valid token was restored.
     */
    restoreToken() {
        if (!this.gapiInited) return false;

        const stored = localStorage.getItem('drive_oauth_token');
        if (stored) {
            try {
                const tokenObj = JSON.parse(stored);
                if (Date.now() < tokenObj.expiresAt) {
                    gapi.client.setToken({ access_token: tokenObj.access_token });
                    return true;
                } else {
                    // Token expired
                    localStorage.removeItem('drive_oauth_token');
                }
            } catch (e) {
                console.error("Failed to parse stored token", e);
                localStorage.removeItem('drive_oauth_token');
            }
        }
        return false;
    }

    handleSignoutClick() {
        const token = gapi.client.getToken();
        if (token !== null) {
            google.accounts.oauth2.revoke(token.access_token);
            gapi.client.setToken('');
            localStorage.removeItem('drive_oauth_token');
        }
    }

    /**
     * Fetches files from Google Drive
     * @param {string} parentId - The ID of the folder to fetch from (defaults to 'root')
     * @returns {Promise<Array>} List of formatted drive items
     */
    async getDriveItems(parentId = 'root') {
        if (!this.gapiInited || gapi.client.getToken() === null) {
            throw new Error('User not authenticated');
        }

        try {
            // Always use standard fetch API so Service Worker can reliably intercept it
            const token = gapi.client.getToken().access_token;
            const params = new URLSearchParams({
                pageSize: 20,
                fields: 'files(id, name, mimeType, modifiedTime, size, parents)',
                q: `'${parentId}' in parents and trashed = false`
            });

            const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            const data = await response.json();
            const files = data.files;

            if (!files || files.length == 0) {
                return [];
            }

            // Map to our generic format
            return files.map(file => {
                let mappedType = 'file';
                if (file.mimeType === 'application/vnd.google-apps.folder') mappedType = 'folder';
                else if (file.mimeType.includes('image')) mappedType = 'image';
                else if (file.mimeType === 'application/vnd.google-apps.document') mappedType = 'doc';
                else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') mappedType = 'sheet';

                let formattedSize = null;
                if (file.size) {
                    const sizeInMb = (file.size / (1024 * 1024)).toFixed(2);
                    formattedSize = sizeInMb > 0.01 ? `${sizeInMb} MB` : `${Math.round(file.size / 1024)} KB`;
                }

                return {
                    id: file.id,
                    name: file.name,
                    type: mappedType,
                    lastModified: file.modifiedTime,
                    size: formattedSize,
                    parentId: file.parents && file.parents.length > 0 ? file.parents[0] : 'root'
                };
            });
        } catch (err) {
            console.error("Error fetching files", err);
            throw err;
        }
    }

    /**
     * Helper to determine the correct FontAwesome icon class for a given file type.
     */
    getIconClass(type) {
        switch (type) {
            case 'folder': return 'fa-solid fa-folder';
            case 'doc': return 'fa-solid fa-file-word';
            case 'sheet': return 'fa-solid fa-file-excel';
            case 'image': return 'fa-solid fa-image';
            default: return 'fa-solid fa-file';
        }
    }
}

// Expose instance globally for the app
window.cloudApi = new CloudApiService();
