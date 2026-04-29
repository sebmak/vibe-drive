document.addEventListener('DOMContentLoaded', () => {
    // Register Service Worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(registration => {
                console.log('Service Worker registered with scope:', registration.scope);
            })
            .catch(error => {
                console.error('Service Worker registration failed:', error);
            });

        // Listen for cache updates from the Service Worker
        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'DRIVE_DATA_UPDATED') {
                console.log('Received updated drive data from Service Worker background fetch.');
                // We need to map the raw API files to our UI format before rendering
                const mappedItems = event.data.files.map(file => {
                    let mappedType = 'file';
                    if (file.mimeType === 'application/vnd.google-apps.folder') mappedType = 'folder';
                    else if (file.mimeType && file.mimeType.includes('image')) mappedType = 'image';
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
                renderItems(mappedItems);
            }
        });
    }

    const driveGrid = document.getElementById('drive-grid');
    const loader = document.getElementById('loader');
    const breadcrumbsContainer = document.getElementById('breadcrumbs');
    
    let folderStack = [{ id: 'root', name: 'My Drive' }];
    
    const authorizeButton = document.getElementById('authorize_button');
    const signoutButton = document.getElementById('signout_button');
    
    // View toggles
    const btnGrid = document.getElementById('btn-grid');
    const btnList = document.getElementById('btn-list');
    
    // Initialize Google API
    window.cloudApi.init(async () => {
        // Callback when SDKs are loaded
        
        // Try to restore an existing valid token
        if (window.cloudApi.restoreToken()) {
            authorizeButton.style.display = 'none';
            signoutButton.style.display = 'block';
            handleHashChange();
        } else {
            authorizeButton.style.display = 'block';
            loader.innerHTML = '<p style="color: var(--text-secondary);">Click Sign In to view your drive files.</p>';
        }
    });

    authorizeButton.onclick = () => {
        window.cloudApi.handleAuthClick(async () => {
            // Successfully authorized
            authorizeButton.style.display = 'none';
            signoutButton.style.display = 'block';
            handleHashChange();
        });
    };

    signoutButton.onclick = () => {
        window.cloudApi.handleSignoutClick();
        authorizeButton.style.display = 'block';
        signoutButton.style.display = 'none';
        driveGrid.innerHTML = '';
        driveGrid.classList.add('hidden');
        loader.classList.remove('hidden');
        loader.innerHTML = '<p style="color: var(--text-secondary);">Click Sign In to view your drive files.</p>';
    };
    
    async function handleHashChange() {
        const hash = window.location.hash;
        let folderId = 'root';
        
        if (hash.startsWith('#/folder/')) {
            folderId = hash.replace('#/folder/', '');
        }

        const existingIndex = folderStack.findIndex(f => f.id === folderId);
        if (existingIndex !== -1) {
            folderStack = folderStack.slice(0, existingIndex + 1);
        } else {
            // Direct link or fresh history state
            if (folderId !== 'root') {
                folderStack = [
                    { id: 'root', name: 'My Drive' },
                    { id: folderId, name: 'Folder' }
                ];
            } else {
                folderStack = [{ id: 'root', name: 'My Drive' }];
            }
        }

        renderBreadcrumbs();
        
        driveGrid.classList.add('hidden');
        loader.classList.remove('hidden');
        loader.innerHTML = '<div class="spinner"></div>';
        
        await loadDriveData(folderId);
    }
    
    window.addEventListener('hashchange', () => {
        if (window.cloudApi.gapiInited && localStorage.getItem('drive_oauth_token')) {
            handleHashChange();
        }
    });

    // Load data
    async function loadDriveData(folderId) {
        try {
            const items = await window.cloudApi.getDriveItems(folderId);
            renderItems(items);
        } catch (error) {
            console.error('Failed to load drive items:', error);
            loader.innerHTML = '<p style="color: #ef4444;">Error loading files. Check console or authentication.</p>';
            
            if (error && error.result && error.result.error && error.result.error.status === 'UNAUTHENTICATED') {
                localStorage.removeItem('drive_oauth_token');
                authorizeButton.style.display = 'block';
                signoutButton.style.display = 'none';
            }
        }
    }

    // Render items to DOM
    function renderItems(items) {
        // Hide loader
        loader.classList.add('hidden');
        driveGrid.classList.remove('hidden');
        
        driveGrid.innerHTML = ''; // Clear existing
        
        if (!items || items.length === 0) {
            driveGrid.innerHTML = '<p style="color: var(--text-secondary); grid-column: 1 / -1;">No items found in your drive.</p>';
            return;
        }

        items.forEach((item, index) => {
            const el = document.createElement('div');
            el.className = 'drive-item';
            
            const iconClass = window.cloudApi.getIconClass(item.type);
            
            el.innerHTML = `
                <div class="item-icon ${item.type}">
                    <i class="${iconClass}"></i>
                </div>
                <div class="item-info">
                    <div class="item-name" title="${item.name}">${item.name}</div>
                    <div class="item-meta">
                        <span>${formatDate(item.lastModified)}</span>
                        ${item.size ? `<span>${item.size}</span>` : ''}
                    </div>
                </div>
            `;
            
            if (item.type === 'folder') {
                el.style.cursor = 'pointer';
                el.addEventListener('click', () => {
                    folderStack.push({ id: item.id, name: item.name });
                    window.location.hash = `/folder/${item.id}`;
                });
            }
            
            driveGrid.appendChild(el);
        });
    }

    // Render breadcrumbs
    function renderBreadcrumbs() {
        breadcrumbsContainer.innerHTML = '';
        
        folderStack.forEach((folder, index) => {
            const span = document.createElement('span');
            span.textContent = folder.name;
            
            if (index === folderStack.length - 1) {
                span.className = 'current';
            } else {
                span.style.cursor = 'pointer';
                span.addEventListener('click', () => {
                    window.location.hash = folder.id === 'root' ? '' : `/folder/${folder.id}`;
                });
            }
            
            breadcrumbsContainer.appendChild(span);
            
            if (index < folderStack.length - 1) {
                const icon = document.createElement('i');
                icon.className = 'fa-solid fa-chevron-right';
                breadcrumbsContainer.appendChild(icon);
            }
        });
    }

    // Utility: Format date
    function formatDate(dateString) {
        if (!dateString) return '';
        const options = { month: 'short', day: 'numeric', year: 'numeric' };
        return new Date(dateString).toLocaleDateString(undefined, options);
    }

    // Handle View Toggles
    btnGrid.addEventListener('click', () => {
        btnGrid.classList.add('active');
        btnList.classList.remove('active');
        driveGrid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(220px, 1fr))';
    });

    btnList.addEventListener('click', () => {
        btnList.classList.add('active');
        btnGrid.classList.remove('active');
        driveGrid.style.gridTemplateColumns = '1fr';
    });
});
