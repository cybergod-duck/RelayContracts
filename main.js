// =============================================================================
// PRODUCTION LINE: ELECTRON MAIN PROCESS ENGINE (BaseRelayV3 Shell)
// Version: 5.5 | Workspace: The Factory
// Status: Production-Ready | Fully Compiled | Zero Placeholders
// =============================================================================

const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');

// Lock the app name so userData path is always %APPDATA%\Relay Wallet\
// regardless of package.json name vs productName
app.setName('Relay Wallet');

// REQUIRED: Route WebAuthn through native Windows API (webauthn.dll)
// Must enable both base WebAuthentication AND the native sub-feature
app.commandLine.appendSwitch('enable-features', 'WebAuthentication,WebAuthenticationUseNativeWindowsApi');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { ethers } = require('ethers');
const QRCode = require('qrcode');

const NETWORKS = {
    base: {
        name: 'Base',
        rpc: 'https://mainnet.base.org',
        weth: '0x4200000000000000000000000000000000000006',
        usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        relay: '0x0382f917af966354D79485D7A4e8322b3A6f4f15',
        proxy: '0x867B0E4946ECe61Fd0A744f4a66b9c1Ef9408aC3', // Updated to Uniswap V3 Relay
        pool: '0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C',
        router: '0x2626664c2603f293e11065a55d650b3f8099176f'  // Uniswap V3 Router
    },
    polygon: {
        name: 'Polygon',
        rpc: 'https://polygon.drpc.org',
        weth: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
        usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
        relay: '',
        proxy: '',
        pool: '0x6e7a5FAFcec6BB1e78bAE2A1F0B612012BF14827',
        router: '0xE592427A0AEce92De3Edee1F18E0157C05861564'  // Uniswap V3 Router
    },
    arbitrum: {
        name: 'Arbitrum',
        rpc: 'https://arb1.arbitrum.io/rpc',
        weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        relay: '',
        proxy: '',
        pool: '',
        router: '0xE592427A0AEce92De3Edee1F18E0157C05861564'
    },
    optimism: {
        name: 'Optimism',
        rpc: 'https://mainnet.optimism.io',
        weth: '0x4200000000000000000000000000000000000006',
        usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
        relay: '',
        proxy: '',
        pool: '',
        router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // SwapRouter02
        routerV2: true
    },
    bsc: {
        name: 'BSC',
        rpc: 'https://bsc-dataseed.binance.org/',
        weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32CD580d',
        relay: '',
        proxy: '',
        pool: '',
        router: '0xB3F8688113AE7563809Ba837DC12dAC54a03CCcD'
    },
    linea: {
        name: 'Linea',
        rpc: 'https://rpc.linea.build',
        weth: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34',
        usdc: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
        relay: '',
        proxy: '',
        pool: '',
        router: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', // SwapRouter02 on Linea (verified LineaScan)
        routerV2: true
    }
};

const STORE_PATH = path.join(app.getPath('userData'), 'wallet.json');

// On first launch after install: seed userData from bundled wallet-seed.json
// if the user's wallet.json doesn't exist yet in appData.
(function seedStoreIfMissing() {
    if (!fs.existsSync(STORE_PATH)) {
        const seedCandidates = [
            path.join(process.resourcesPath || '', 'app', 'wallet-seed.json'),
            path.join(process.resourcesPath || '', 'app.asar.unpacked', 'wallet-seed.json'),
            path.join(__dirname, 'wallet-seed.json')
        ];
        for (const seed of seedCandidates) {
            if (fs.existsSync(seed)) {
                try {
                    const dir = path.dirname(STORE_PATH);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.copyFileSync(seed, STORE_PATH);
                    break;
                } catch (e) { /* continue */ }
            }
        }
    }
})();

let wallet = null;
const providers = {};
for (const key of Object.keys(NETWORKS)) {
    providers[key] = new ethers.providers.JsonRpcProvider(NETWORKS[key].rpc);
}
let provider = providers.base;

// =============================================================================
// AES-256-GCM helpers (Node crypto)
// =============================================================================
function encryptGCM(key, plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        iv: iv.toString('hex'),
        ct: Buffer.concat([ct, tag]).toString('hex')
    };
}

function decryptGCM(key, envelope) {
    const iv = Buffer.from(envelope.iv, 'hex');
    const data = Buffer.from(envelope.ct, 'hex');
    const ct = data.subarray(0, data.length - 16);
    const tag = data.subarray(data.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct, null, 'utf8') + decipher.final('utf8');
}

// =============================================================================
// Password envelope: scrypt(password, randomSalt, 32) → AES-256-GCM → encrypt privateKey
// =============================================================================
function createPwEnvelope(privateKey, password) {
    const salt = crypto.randomBytes(32);
    const key = crypto.scryptSync(password, salt, 32);
    const envelope = encryptGCM(key, privateKey);
    envelope.salt = salt.toString('hex');
    return envelope;
}

// Unlock key helper
function decryptPwEnvelope(envelope, password) {
    const salt = Buffer.from(envelope.salt, 'hex');
    const key = crypto.scryptSync(password, salt, 32);
    return decryptGCM(key, envelope);
}

// =============================================================================
// Bio envelope: PRF key (32 bytes from WebAuthn PRF extension) → AES-256-GCM → encrypt privateKey
// The PRF key is provided by the renderer (computed by TPM from biometric, never touches disk)
// =============================================================================
function createBioEnvelopeFromPRF(privateKey, prfKey) {
    return encryptGCM(prfKey, privateKey);
}

function decryptBioEnvelopeWithPRF(envelope, prfKey) {
    return decryptGCM(prfKey, envelope);
}

// =============================================================================
// Window — served over http://localhost (secure context for WebAuthn)
// =============================================================================
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

let mainWindow = null;

function createWindow() {
    // Simple localhost HTTP server
    const server = http.createServer((req, res) => {
        let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
        const fullPath = path.join(__dirname, filePath);
        const ext = path.extname(fullPath);
        try {
            const content = fs.readFileSync(fullPath);
            res.writeHead(200, { 'Content-Type': MIME[ext.toLowerCase()] || 'text/plain' });
            res.end(content);
        } catch (e) {
            res.writeHead(404);
            res.end('Not found');
        }
    });
    server.listen(0, 'localhost', () => {
        const port = server.address().port;

        // Snug container limits preventing clipping anomalies
        mainWindow = new BrowserWindow({
            width: 440,
            height: 410,
            resizable: false,
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            title: 'Relay Wallet',
            icon: path.join(__dirname, 'ICON.png'),
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            }
        });

        // Full-bleed premium purple color shift + sharp 1px cyan bounding lock
        mainWindow.webContents.on('did-finish-load', () => {
            mainWindow.webContents.insertCSS(`
                html, body {
                    width: 100vw !important;
                    height: 100vh !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    background: transparent !important;
                    overflow: hidden !important;
                }
                .app {
                    width: 100vw !important;
                    height: 100vh !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    background: #0d0d18 !important;
                    border: 1.5px solid #00d2ff !important;
                    box-sizing: border-box !important;
                    border-radius: 18px !important;
                    display: flex !important;
                    flex-direction: column !important;
                    overflow: hidden !important;
                }
                #locked {
                    width: 92% !important;
                    max-width: 390px !important;
                    margin: auto !important;
                    background: transparent !important;
                    border: none !important;
                    box-shadow: none !important;
                }
            `);
        });

        mainWindow.setMenuBarVisibility(false);
        mainWindow.loadURL(`http://localhost:${port}/index.html`);
        mainWindow.webContents.openDevTools();
    });
}

// Dynamic window resize — accepts both width and height
ipcMain.handle('window:resize', (_, w, h) => {
    if (mainWindow) mainWindow.setSize(w, h);
});
ipcMain.handle('window:close', () => {
    if (mainWindow) mainWindow.close();
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// =============================================================================
// Store persistence (wallet.json in userData)
// =============================================================================
function loadStore() {
    if (!fs.existsSync(STORE_PATH)) return null;
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (store) {
        if (store.polygonRelay) NETWORKS.polygon.relay = store.polygonRelay;
        if (store.polygonProxy) NETWORKS.polygon.proxy = store.polygonProxy;
        
        if (store.arbitrumRelay) NETWORKS.arbitrum.relay = store.arbitrumRelay;
        if (store.arbitrumProxy) NETWORKS.arbitrum.proxy = store.arbitrumProxy;
        
        if (store.optimismRelay) NETWORKS.optimism.relay = store.optimismRelay;
        if (store.optimismProxy) NETWORKS.optimism.proxy = store.optimismProxy;
        
        if (store.bscRelay) NETWORKS.bsc.relay = store.bscRelay;
        if (store.bscProxy) NETWORKS.bsc.proxy = store.bscProxy;
        
        if (store.lineaRelay) NETWORKS.linea.relay = store.lineaRelay;
        if (store.lineaProxy) NETWORKS.linea.proxy = store.lineaProxy;
    }
    return store;
}

function saveStore(data) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

// =============================================================================
// IPC Handlers
// =============================================================================

ipcMain.handle('wallet:exists', () => fs.existsSync(STORE_PATH));

// Create new wallet: generate keypair, encrypt with password, persist both envelopes empty
ipcMain.handle('wallet:create', (_, password) => {
    wallet = ethers.Wallet.createRandom();
    const pwEnvelope = createPwEnvelope(wallet.privateKey, password);
    const store = {
        address: wallet.address,
        pwEnvelope: pwEnvelope,
        bioEnvelope: null
    };
    saveStore(store);
    return {
        address: wallet.address,
        privateKey: wallet.privateKey  // returned ONCE for biometric envelope setup in renderer
    };
});

// Save biometric envelope after WebAuthn PRF enrollment in renderer
ipcMain.handle('wallet:save-bio', (_, bioEnvelope) => {
    const store = loadStore();
    if (!store) return { error: 'No wallet exists' };
    store.bioEnvelope = bioEnvelope;
    saveStore(store);
    return { ok: true };
});

// Load biometric envelope for renderer-side decryption
ipcMain.handle('wallet:load-bio', () => {
    const store = loadStore();
    if (!store || !store.bioEnvelope) return null;
    return store.bioEnvelope;
});

// Unlock with password: scrypt derive → AES-GCM decrypt pwEnvelope
ipcMain.handle('wallet:unlock', (_, password) => {
    try {
        const store = loadStore();
        if (!store) return { error: 'No wallet found' };
        const privateKey = decryptPwEnvelope(store.pwEnvelope, password);
        wallet = new ethers.Wallet(privateKey, provider);
        return { address: wallet.address };
    } catch (e) {
        return { error: 'Wrong password or corrupt wallet' };
    }
});

// Unlock with biometric: renderer already decrypted bioEnvelope → sends privateKey
ipcMain.handle('wallet:unlock-bio', (_, privateKey) => {
    try {
        wallet = new ethers.Wallet(privateKey, provider);
        const store = loadStore();
        if (store && !store.devKey) {
            store.devKey = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(privateKey).toString('base64') : privateKey;
            saveStore(store);
        }
        return { address: wallet.address };
    } catch (e) {
        return { error: 'Failed to unlock with biometric key: ' + e.message };
    }
});

ipcMain.handle('wallet:balance', async () => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    const balances = {};
    for (const key of Object.keys(NETWORKS)) {
        try {
            const bal = await providers[key].getBalance(wallet.address);
            balances[key] = {
                eth: ethers.utils.formatEther(bal),
                wei: bal.toString()
            };
        } catch (e) {
            balances[key] = { eth: '0', wei: '0', error: e.message };
        }
    }
    return balances;
});

ipcMain.handle('wallet:address', () => wallet ? wallet.address : null);

ipcMain.handle('wallet:lock', () => { wallet = null; return { ok: true }; });

// Set up PIN: encrypt private key with scrypt(PIN) → store in wallet.json
ipcMain.handle('wallet:setPin', (_, pin) => {
    if (!wallet) return { error: 'Wallet not unlocked — enter password first' };
    try {
        const store = loadStore();
        const salt = crypto.randomBytes(32);
        const key = crypto.scryptSync(pin, salt, 32);
        store.pinEnvelope = { ...encryptGCM(key, wallet.privateKey), salt: salt.toString('hex') };
        saveStore(store);
        return { ok: true };
    } catch (e) { return { error: e.message }; }
});

// Unlock with PIN: scrypt(PIN) → AES-GCM decrypt

ipcMain.handle('wallet:unlockWithPin', (_, pin) => {
    try {
        const store = loadStore();
        if (!store || !store.pinEnvelope) return { error: 'No PIN set up' };
        const salt = Buffer.from(store.pinEnvelope.salt, 'hex');
        const key = crypto.scryptSync(pin, salt, 32);
        const privateKey = decryptGCM(key, store.pinEnvelope);
        wallet = new ethers.Wallet(privateKey, provider);
        return { address: wallet.address };
    } catch (e) { return { error: 'Wrong PIN' }; }
});

ipcMain.handle('wallet:devUnlock', async () => {
    if (app.isPackaged) {
        return { error: 'Dev unlock disabled in production' };
    }
    try {
        const store = loadStore();
        if (!store || !store.devKey) return { error: 'No dev key saved' };
        
        let privateKey;
        if (safeStorage.isEncryptionAvailable()) {
            try {
                const buf = Buffer.from(store.devKey, 'base64');
                privateKey = safeStorage.decryptString(buf);
            } catch (e) {
                privateKey = store.devKey;
            }
        } else {
            privateKey = store.devKey;
        }
        
        wallet = new ethers.Wallet(privateKey, provider);
        return { address: wallet.address };
    } catch (e) {
        return { error: 'Failed to unlock with dev key: ' + e.message };
    }
});

ipcMain.handle('wallet:generateQR', async (_, text) => {
    try {
        return await QRCode.toDataURL(text, { width: 260, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
    } catch (e) { return { error: e.message }; }
});

// =============================================================================
// SEND ETH / ERC-20 TOKENS
// =============================================================================
ipcMain.handle('wallet:send', async (_, to, amount, networkKey = 'base', token = 'native') => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    try {
        const prov = providers[networkKey];
        const signer = wallet.connect(prov);
        
        if (token === 'native') {
            const tx = await signer.sendTransaction({ to, value: ethers.utils.parseEther(amount) });
            await tx.wait();
            return { hash: tx.hash };
        } else if (token === 'usdc') {
            const decimals = networkKey === 'bsc' ? 18 : 6;
            const amountUnits = ethers.utils.parseUnits(amount, decimals);
            let tokenAddress = NETWORKS[networkKey].usdc;
            if (networkKey === 'polygon') {
                // If native USDC has enough balance, use it. Otherwise use USDC.e.
                const nativeUsdcAddr = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
                const nativeUsdc = new ethers.Contract(nativeUsdcAddr, ['function balanceOf(address) view returns (uint256)'], signer);
                const nativeBal = await nativeUsdc.balanceOf(wallet.address);
                if (nativeBal.gte(amountUnits)) {
                    tokenAddress = nativeUsdcAddr;
                }
            }
            const tokenContract = new ethers.Contract(tokenAddress, [
                'function transfer(address to, uint256 amount) returns (bool)'
            ], signer);
            const tx = await tokenContract.transfer(to, amountUnits);
            await tx.wait();
            return { hash: tx.hash };
        } else if (token === 'weth') {
            const decimals = 18;
            const amountUnits = ethers.utils.parseUnits(amount, decimals);
            const tokenContract = new ethers.Contract(NETWORKS[networkKey].weth, [
                'function transfer(address to, uint256 amount) returns (bool)'
            ], signer);
            const tx = await tokenContract.transfer(to, amountUnits);
            await tx.wait();
            return { hash: tx.hash };
        } else {
            return { error: 'Unsupported token type' };
        }
    } catch (e) { return { error: e.message }; }
});

// =============================================================================
// TRANSACTION HISTORY — Blockscout & Etherscan APIs (including token transfers)
// =============================================================================
ipcMain.handle('wallet:baseAddresses', () => {
    return {
        relay: NETWORKS.base.relay || '',
        proxy: NETWORKS.base.proxy || ''
    };
});

ipcMain.handle('wallet:polygonAddresses', () => {
    return {
        relay: NETWORKS.polygon.relay || '',
        proxy: NETWORKS.polygon.proxy || ''
    };
});

ipcMain.handle('wallet:arbitrumAddresses', () => {
    return {
        relay: NETWORKS.arbitrum.relay || '',
        proxy: NETWORKS.arbitrum.proxy || ''
    };
});

ipcMain.handle('wallet:optimismAddresses', () => {
    return {
        relay: NETWORKS.optimism.relay || '',
        proxy: NETWORKS.optimism.proxy || ''
    };
});

ipcMain.handle('wallet:bscAddresses', () => {
    return {
        relay: NETWORKS.bsc.relay || '',
        proxy: NETWORKS.bsc.proxy || ''
    };
});

ipcMain.handle('wallet:lineaAddresses', () => {
    return {
        relay: NETWORKS.linea.relay || '',
        proxy: NETWORKS.linea.proxy || ''
    };
});

ipcMain.handle('wallet:txHistory', async () => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    const https = require('https');
    
    const fetchJson = (url) => {
        return new Promise((resolve) => {
            const parsed = new URL(url);
            const options = {
                hostname: parsed.hostname,
                path: parsed.pathname + parsed.search,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            };
            https.get(options, (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(d));
                    } catch (e) { resolve(null); }
                });
            }).on('error', () => resolve(null));
        });
    };

    try {
        const baseUr = `https://base.blockscout.com/api/v2/addresses/${wallet.address}/transactions`;
        const baseTokenUr = `https://base.blockscout.com/api/v2/addresses/${wallet.address}/token-transfers`;
        const polyUrl = `https://api.etherscan.io/v2/api?chainid=137&module=account&action=txlist&address=${wallet.address}&startblock=0&endblock=99999999&sort=desc&apikey=A38YCUHMVMNENXS3N9H7HI1Q18K7NUQT14`;
        const polyTokenUrl = `https://api.etherscan.io/v2/api?chainid=137&module=account&action=tokentx&address=${wallet.address}&startblock=0&endblock=99999999&sort=desc&apikey=A38YCUHMVMNENXS3N9H7HI1Q18K7NUQT14`;

        const [baseRes, baseTokenRes, polyRes, polyTokenRes] = await Promise.all([
            fetchJson(baseUr),
            fetchJson(baseTokenUr),
            fetchJson(polyUrl),
            fetchJson(polyTokenUrl)
        ]);

        let baseTxs = [];
        if (baseRes && baseRes.items) {
            baseTxs = baseRes.items.map(tx => ({
                hash: tx.hash,
                from: tx.from?.hash || '',
                to: tx.to?.hash || '',
                value: ethers.utils.formatEther(tx.value || '0'),
                symbol: 'ETH',
                timeStamp: tx.timestamp || '',
                blockNumber: tx.block || 0,
                network: 'Base',
                method: tx.method || '',
                isToken: false
            }));
        }

        let baseTokens = [];
        if (baseTokenRes && baseTokenRes.items) {
            baseTokens = baseTokenRes.items.map(tx => {
                const decimals = parseInt(tx.token?.decimals || '18');
                const rawValue = tx.total?.value || '0';
                const formattedValue = ethers.utils.formatUnits(rawValue, decimals);
                return {
                    hash: tx.transaction_hash || '',
                    from: tx.from?.hash || '',
                    to: tx.to?.hash || '',
                    value: formattedValue,
                    symbol: tx.token?.symbol || '',
                    timeStamp: tx.timestamp || '',
                    blockNumber: tx.block_number || 0,
                    network: 'Base',
                    method: tx.method || 'Transfer',
                    isToken: true
                };
            });
        }

        let polyTxs = [];
        if (polyRes && polyRes.result && polyRes.status === '1' && Array.isArray(polyRes.result)) {
            polyTxs = polyRes.result.map(tx => {
                let cleanMethod = '';
                if (tx.functionName) {
                    cleanMethod = tx.functionName.split('(')[0];
                } else if (tx.input && tx.input !== '0x') {
                    cleanMethod = 'Contract Call';
                }
                return {
                    hash: tx.hash,
                    from: tx.from || '',
                    to: tx.to || '',
                    value: ethers.utils.formatEther(tx.value || '0'),
                    symbol: 'POL',
                    timeStamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
                    blockNumber: parseInt(tx.blockNumber) || 0,
                    network: 'Polygon',
                    method: cleanMethod,
                    isToken: false
                };
            });
        }

        let polyTokens = [];
        if (polyTokenRes && polyTokenRes.result && polyTokenRes.status === '1' && Array.isArray(polyTokenRes.result)) {
            polyTokens = polyTokenRes.result.map(tx => {
                const decimals = parseInt(tx.tokenDecimal || '18');
                const formattedValue = ethers.utils.formatUnits(tx.value || '0', decimals);
                let cleanMethod = '';
                if (tx.functionName) {
                    cleanMethod = tx.functionName.split('(')[0];
                } else if (tx.methodId && tx.methodId !== '0x') {
                    cleanMethod = tx.methodId;
                } else {
                    cleanMethod = 'Transfer';
                }
                return {
                    hash: tx.hash || '',
                    from: tx.from || '',
                    to: tx.to || '',
                    value: formattedValue,
                    symbol: tx.tokenSymbol || '',
                    timeStamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
                    blockNumber: parseInt(tx.blockNumber) || 0,
                    network: 'Polygon',
                    method: cleanMethod,
                    isToken: true
                };
            });
        }

        // Combine all EOA and Token transfers
        const allItems = [...baseTxs, ...baseTokens, ...polyTxs, ...polyTokens];
        
        // Group by hash
        const grouped = {};
        const ALLOWED_SYMBOLS = ['USDC', 'USDC.E', 'WETH', 'WPOL', 'POL', 'ETH'];
        const walletAddressLower = wallet.address.toLowerCase();
        
        allItems.forEach(item => {
            if (!item.hash) return;
            const hash = item.hash.toLowerCase();
            if (!grouped[hash]) {
                grouped[hash] = [];
            }
            grouped[hash].push(item);
        });

        const merged = [];
        
        for (const hash in grouped) {
            const txsForHash = grouped[hash];
            
            // Find token transfers that are in the ALLOWED list
            const allowedTokens = txsForHash.filter(tx => tx.isToken && ALLOWED_SYMBOLS.includes(tx.symbol.toUpperCase()));
            
            if (allowedTokens.length > 0) {
                // Priority Score: Incoming USDC/USDC.e is highest, then Outgoing USDC, then WETH
                allowedTokens.sort((a, b) => {
                    const score = (tx) => {
                        const sym = tx.symbol.toUpperCase();
                        const isIn = tx.to.toLowerCase() === walletAddressLower;
                        let points = 0;
                        if (sym.startsWith('USDC')) points += 100;
                        if (sym.startsWith('WETH')) points += 50;
                        if (isIn) points += 10;
                        return points;
                    };
                    return score(b) - score(a);
                });
                
                const bestToken = allowedTokens[0];
                
                // Merge EOA method if token transfer method is empty or generic
                const eoa = txsForHash.find(tx => !tx.isToken);
                if (eoa && eoa.method && (!bestToken.method || bestToken.method === 'Transfer')) {
                    bestToken.method = eoa.method;
                }
                
                merged.push(bestToken);
            } else {
                // No allowed token transfers: use EOA transaction (native ETH/POL) if present
                const eoa = txsForHash.find(tx => !tx.isToken);
                if (eoa) {
                    merged.push(eoa);
                }
            }
        }

        // Sort chronologically (newest first)
        merged.sort((a, b) => new Date(b.timeStamp) - new Date(a.timeStamp));
        const combined = merged.slice(0, 100);

        return { txs: combined };
    } catch (e) {
        return { txs: [] };
    }
});

// =============================================================================
// Helper for Polygon Gas Overrides (minimum 25 Gwei Priority Fee)
// =============================================================================
async function getPolygonGasOverrides(prov) {
    try {
        const feeData = await prov.getFeeData();
        const minPriorityFee = ethers.utils.parseUnits('25', 'gwei');
        let maxPriorityFee = feeData.maxPriorityFeePerGas || minPriorityFee;
        if (maxPriorityFee.lt(minPriorityFee)) {
            maxPriorityFee = minPriorityFee;
        }
        let maxFee = feeData.maxFeePerGas;
        if (feeData.lastBaseFeePerGas) {
            maxFee = feeData.lastBaseFeePerGas.mul(2).add(maxPriorityFee);
        } else {
            maxFee = maxPriorityFee.add(ethers.utils.parseUnits('25', 'gwei'));
        }
        return {
            maxPriorityFeePerGas: maxPriorityFee,
            maxFeePerGas: maxFee
        };
    } catch (e) {
        return {
            maxPriorityFeePerGas: ethers.utils.parseUnits('30', 'gwei'),
            maxFeePerGas: ethers.utils.parseUnits('60', 'gwei')
        };
    }
}

// =============================================================================
// RELAY: ETH → WETH wrap
// =============================================================================
const WETH_ABI = ['function deposit() payable', 'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'];

ipcMain.handle('relay:wrap', async (_, amountEth, networkKey = 'base') => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    try {
        const net = NETWORKS[networkKey];
        const signer = wallet.connect(providers[networkKey]);
        const weth = new ethers.Contract(net.weth, WETH_ABI, signer);
        const tx = await weth.deposit({ value: ethers.utils.parseEther(amountEth) });
        await tx.wait();
        return { hash: tx.hash };
    } catch (e) { return { error: e.message }; }
});

// =============================================================================
// RELAY V3: Route WETH→USDC swap through Relay or Router
// =============================================================================
const RELAY_V3_ABI = ['function swap(address,address,uint256,uint256,address[],uint256) returns (uint256,uint256)'];

ipcMain.handle('relay:boostV3', async (_, amountEth, networkKey = 'base') => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    try {
        const net = NETWORKS[networkKey];
        const prov = providers[networkKey];
        const signer = wallet.connect(prov);
        
        const weth = new ethers.Contract(net.weth, WETH_ABI, signer);
        const amountWei = ethers.utils.parseEther(amountEth);

        const wethBal = await weth.balanceOf(wallet.address);
        if (wethBal.lt(amountWei)) {
            const ethBal = await prov.getBalance(wallet.address);
            if (ethBal.lt(amountWei)) {
                return { error: 'Need ' + amountEth + ' ETH. Have: ' + (+ethers.utils.formatEther(ethBal)).toFixed(6) };
            }
            const wrapTx = await weth.deposit({ value: amountWei });
            await wrapTx.wait();
        }

        const deadline = Math.floor(Date.now() / 1000) + 300;
        
        // Dynamically query router quote for WETH->USDC and apply 2% slippage
        let minOut;
        try {
            const routerContract = new ethers.Contract(net.router, [
                'function getAmountsOut(uint256 amountIn, address[] path) external view returns (uint256[] memory)'
            ], signer);
            const amounts = await routerContract.getAmountsOut(amountWei, [net.weth, net.usdc]);
            minOut = amounts[amounts.length - 1].mul(98).div(100); // 2% slippage protection
        } catch (err) {
            if (networkKey === 'bsc') {
                minOut = amountWei.mul(300);
            } else {
                minOut = amountWei.mul(1500).div(ethers.BigNumber.from("1000000000000"));
            }
        }

        if (net.relay && net.relay !== '') {
            const approveTx = await weth.approve(net.relay, amountWei);
            await approveTx.wait();

            const relay = new ethers.Contract(net.relay, RELAY_V3_ABI, signer);
            const swapTx = await relay.swap(
                net.weth, net.usdc, amountWei, minOut, [net.pool], deadline,
                { gasLimit: 500000 }
            );
            await swapTx.wait();
            return { hash: swapTx.hash, amount: amountEth, network: net.name };
        } else {
            // Fallback to standard V2 Router
            const approveTx = await weth.approve(net.router, amountWei);
            await approveTx.wait();

            const router = new ethers.Contract(net.router, [
                'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])'
            ], signer);
            const swapTx = await router.swapExactTokensForTokens(
                amountWei, minOut, [net.weth, net.usdc], wallet.address, deadline,
                { gasLimit: 500000 }
            );
            await swapTx.wait();
            return { hash: swapTx.hash, amount: amountEth, network: net.name };
        }
    } catch (e) {
        let msg = e.reason || e.message || 'Boost failed';
        if (e.error && e.error.message) msg = e.error.message;
        return { error: msg };
    }
});

ipcMain.handle('relay:wethBalance', async () => {
    if (!wallet) return {};
    const wethBal = {};
    for (const key of Object.keys(NETWORKS)) {
        try {
            const net = NETWORKS[key];
            const weth = new ethers.Contract(net.weth, WETH_ABI, providers[key]);
            const bal = await weth.balanceOf(wallet.address);
            wethBal[key] = ethers.utils.formatEther(bal);
        } catch (e) {
            wethBal[key] = '0';
        }
    }
    return wethBal;
});

ipcMain.handle('wallet:usdcBalance', async () => {
    if (!wallet) return {};
    const usdcBal = {};
    for (const key of Object.keys(NETWORKS)) {
        try {
            const net = NETWORKS[key];
            const usdc = new ethers.Contract(net.usdc, ['function balanceOf(address) view returns (uint256)'], providers[key]);
            let bal = await usdc.balanceOf(wallet.address);
            if (key === 'polygon') {
                const nativeUsdcAddr = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
                const nativeUsdc = new ethers.Contract(nativeUsdcAddr, ['function balanceOf(address) view returns (uint256)'], providers[key]);
                const nativeBal = await nativeUsdc.balanceOf(wallet.address);
                bal = bal.add(nativeBal);
            }
            const decimals = key === 'bsc' ? 18 : 6;
            usdcBal[key] = ethers.utils.formatUnits(bal, decimals);
        } catch (e) {
            usdcBal[key] = '0';
        }
    }
    return usdcBal;
});

ipcMain.handle('wallet:estimateGas', async (_, to, amountEth, networkKey = 'base') => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    try {
        const prov = providers[networkKey];
        const signer = wallet.connect(prov);
        const gasEst = await signer.estimateGas({ to, value: ethers.utils.parseEther(amountEth || '0.001') });
        const feeData = await prov.getFeeData();
        const gp = feeData.maxFeePerGas || feeData.gasPrice || ethers.utils.parseUnits('1', 'gwei');
        return { gasEst: gasEst.toString(), gasCostEth: ethers.utils.formatEther(gasEst.mul(gp)) };
    } catch (e) { return { error: e.message }; }
});

// =============================================================================
// SWEEP TO USDC — Automates wrapping ETH and swapping ALL WETH to USDC
// =============================================================================
ipcMain.handle('relay:sweepToUsdc', async (_, networkKey = 'base') => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    try {
        const net = NETWORKS[networkKey];
        const prov = providers[networkKey];
        const signer = wallet.connect(prov);

        if (networkKey === 'polygon') {
            const overrides = await getPolygonGasOverrides(prov);
            const wethContract = new ethers.Contract(net.weth, WETH_ABI, signer);
            const wethBal = await wethContract.balanceOf(wallet.address);
            
            const routerContract = new ethers.Contract(net.router, [
                'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])',
                'function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])'
            ], signer);

            let swapCount = 0;
            let lastHash = '';
            let sweptWeth = '0';
            let sweptPol = '0';

            // 1. Swap WETH -> USDC.e
            if (wethBal.gt(0)) {
                const approveTx = await wethContract.approve(net.router, wethBal, overrides);
                await approveTx.wait();

                const deadline = Math.floor(Date.now() / 1000) + 300;
                const path = [net.weth, net.usdc];
                const swapTx = await routerContract.swapExactTokensForTokens(
                    wethBal, 0, path, wallet.address, deadline,
                    { gasLimit: 250000, ...overrides }
                );
                await swapTx.wait();
                lastHash = swapTx.hash;
                sweptWeth = ethers.utils.formatEther(wethBal);
                swapCount++;
            }

            // 2. Swap POL -> USDC.e leaving 2.0 POL gas buffer
            const polBal = await prov.getBalance(wallet.address);
            const gasBuffer = ethers.utils.parseEther("2.0");
            if (polBal.gt(gasBuffer)) {
                const swapAmount = polBal.sub(gasBuffer);
                const wpolAddr = '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270';
                const path = [wpolAddr, net.usdc];
                const deadline = Math.floor(Date.now() / 1000) + 300;

                const swapTx = await routerContract.swapExactETHForTokens(
                    0, path, wallet.address, deadline,
                    { value: swapAmount, gasLimit: 250000, ...overrides }
                );
                await swapTx.wait();
                lastHash = swapTx.hash;
                sweptPol = ethers.utils.formatEther(swapAmount);
                swapCount++;
            }

            if (swapCount > 0) {
                let msg = '';
                if (sweptWeth !== '0') msg += sweptWeth + ' WETH';
                if (sweptPol !== '0') {
                    if (msg) msg += ' and ';
                    msg += sweptPol + ' POL';
                }
                return { hash: lastHash, amount: msg, network: net.name };
            } else {
                return { error: 'No WETH or extra POL (above 2.0 POL gas buffer) to sweep on ' + net.name };
            }
        }
        
        const weth = new ethers.Contract(net.weth, WETH_ABI, signer);
        const ethBal = await prov.getBalance(wallet.address);
        
        // Wrap ETH to WETH, leaving 0.001 buffer for future gas
        const gasBuffer = ethers.utils.parseEther("0.001");
        if (ethBal.gt(gasBuffer)) {
            const wrapAmount = ethBal.sub(gasBuffer);
            const wrapTx = await weth.deposit({ value: wrapAmount });
            await wrapTx.wait();
        }

        const wethBal = await weth.balanceOf(wallet.address);
        if (wethBal.gt(0)) {
            const deadline = Math.floor(Date.now() / 1000) + 300;
            
            // Dynamically query router quote for WETH->USDC and apply 2% slippage
            let minOut;
            try {
                const routerContract = new ethers.Contract(net.router, [
                    'function getAmountsOut(uint256 amountIn, address[] path) external view returns (uint256[] memory)'
                ], signer);
                const amounts = await routerContract.getAmountsOut(wethBal, [net.weth, net.usdc]);
                minOut = amounts[amounts.length - 1].mul(98).div(100); // 2% slippage protection
            } catch (err) {
                if (networkKey === 'bsc') {
                    minOut = wethBal.mul(300);
                } else {
                    minOut = wethBal.mul(1500).div(ethers.BigNumber.from("1000000000000"));
                }
            }

            if (net.relay && net.relay !== '') {
                const approveTx = await weth.approve(net.relay, wethBal);
                await approveTx.wait();

                const relay = new ethers.Contract(net.relay, RELAY_V3_ABI, signer);
                const swapTx = await relay.swap(
                    net.weth, net.usdc, wethBal, minOut, [net.pool], deadline,
                    { gasLimit: 500000 }
                );
                await swapTx.wait();
                return { hash: swapTx.hash, amount: ethers.utils.formatEther(wethBal), network: net.name };
            } else {
                // Fallback to Router
                const approveTx = await weth.approve(net.router, wethBal);
                await approveTx.wait();

                const router = new ethers.Contract(net.router, [
                    'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])'
                ], signer);
                const swapTx = await router.swapExactTokensForTokens(
                    wethBal, minOut, [net.weth, net.usdc], wallet.address, deadline,
                    { gasLimit: 500000 }
                );
                await swapTx.wait();
                return { hash: swapTx.hash, amount: ethers.utils.formatEther(wethBal), network: net.name };
            }
        } else {
            return { error: 'No ETH or WETH to sweep on ' + net.name };
        }
    } catch (e) {
        let msg = e.reason || e.message || 'Sweep failed';
        if (e.error && e.error.message) msg = e.error.message;
        return { error: msg };
    }
});

// =============================================================================
// CUSTOM BRIDGE — Bridges specific amounts of USDC/WETH between networks
// =============================================================================
ipcMain.handle('relay:customBridge', async (_, fromKey, toKey, tokenKey, amountStr) => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    const https = require('https');
    
    try {
        const srcNet = NETWORKS[fromKey];
        const dstNet = NETWORKS[toKey];
        const prov = providers[fromKey];
        const signer = wallet.connect(prov);
        
        const chainIds = { base: 8453, polygon: 137, arbitrum: 42161, optimism: 10, bsc: 56, linea: 59144 };
        const srcChainId = chainIds[fromKey];
        const dstChainId = chainIds[toKey];
        
        if (!srcChainId || !dstChainId) return { error: 'Unsupported network' };
        if (srcChainId === dstChainId) return { error: 'Source and destination must be different' };

        const overrides = fromKey === 'polygon' ? await getPolygonGasOverrides(prov) : {};

        // ── ETH path: wrap → WETH, swap WETH → USDC on source, bridge USDC to dest ──
        if (tokenKey === 'eth') {
            if (fromKey === 'polygon' || fromKey === 'bsc') {
                return { error: 'No native ETH on Polygon or BSC. Use USDC instead.' };
            }

            const amountUnits = ethers.utils.parseEther(amountStr);

            // Check native ETH balance
            const ethBal = await prov.getBalance(wallet.address);
            if (ethBal.lt(amountUnits)) {
                return { error: `Not enough ETH on ${srcNet.name}. Have: ${parseFloat(ethers.utils.formatEther(ethBal)).toFixed(6)} ETH` };
            }

            // Step 1: Wrap ETH → WETH
            const wethContract = new ethers.Contract(srcNet.weth, ['function deposit() payable', 'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], signer);
            const wrapTx = await wethContract.deposit({ value: amountUnits, gasLimit: 60000, ...overrides });
            await wrapTx.wait();

            // Step 2: Swap WETH → USDC via Uniswap V3 on source chain
            const uniV3RouterABI = ['function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256)'];
            const uniV3Router = new ethers.Contract(srcNet.router, uniV3RouterABI, signer);
            const deadline = Math.floor(Date.now() / 1000) + 600;

            // Use native USDC on Polygon, standard USDC elsewhere
            const srcUsdc = fromKey === 'polygon' ? '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' : srcNet.usdc;

            const approveTx = await wethContract.approve(srcNet.router, amountUnits, { gasLimit: 60000, ...overrides });
            await approveTx.wait();

            let usdcReceived;
            for (const fee of [500, 3000, 100]) {
                try {
                    const swapTx = await uniV3Router.exactInputSingle({
                        tokenIn: srcNet.weth,
                        tokenOut: srcUsdc,
                        fee,
                        recipient: wallet.address,
                        deadline,
                        amountIn: amountUnits,
                        amountOutMinimum: 0,
                        sqrtPriceLimitX96: 0
                    }, { gasLimit: 300000, ...overrides });
                    await swapTx.wait();
                    const usdcContract = new ethers.Contract(srcUsdc, ['function balanceOf(address) view returns (uint256)'], signer);
                    usdcReceived = await usdcContract.balanceOf(wallet.address);
                    break;
                } catch (e) { continue; }
            }

            if (!usdcReceived || usdcReceived.eq(0)) {
                return { error: 'WETH → USDC swap failed on ' + srcNet.name + '. Try bridging USDC directly.' };
            }

            // Step 3: Bridge USDC → destination via Across
            const dstUsdc = toKey === 'polygon' ? '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' : dstNet.usdc;
            const spokePoolAddrs = { base: '0x090C53Ed1dEaf056ca7f193563914A4237D0c0c7', polygon: '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096', arbitrum: '0xe35E9842A20b3205E324596763e4Ad8060c1BC27', optimism: '0x6F26Df09F98a26DBD8F8A2088E0285A21406352f', linea: '0x7e63A5f187313386e8A9d31195A624b51458eE75' };
            const spokePoolAddr = spokePoolAddrs[fromKey];

            let quote;
            try {
                quote = await new Promise((resolve, reject) => {
                    const url = `https://across.to/api/suggested-fees?inputToken=${srcUsdc}&outputToken=${dstUsdc}&originChainId=${srcChainId}&destinationChainId=${dstChainId}&amount=${usdcReceived}`;
                    https.get(url, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{ const j=JSON.parse(d); j.error?reject(new Error(j.message)):resolve(j); }catch(e){reject(e);} }); }).on('error',reject);
                });
            } catch (e) {
                quote = { spokePoolAddress: spokePoolAddr, outputAmount: usdcReceived.mul(99).div(100).toString(), quoteTimestamp: Math.floor(Date.now()/1000), exclusiveRelayer: '0x0000000000000000000000000000000000000000', exclusivityDeadline: 0, fillDeadline: Math.floor(Date.now()/1000)+7200 };
            }

            const activeSpokePool = quote.spokePoolAddress || spokePoolAddr;
            const usdcContract = new ethers.Contract(srcUsdc, ERC20_ABI_BRIDGE, signer);
            const approveSpoke = await usdcContract.approve(activeSpokePool, usdcReceived, { gasLimit: 80000, ...overrides });
            await approveSpoke.wait();

            const spokePool = new ethers.Contract(activeSpokePool, SPOKE_POOL_ABI, signer);
            const bridgeTx = await spokePool.depositV3(
                wallet.address, wallet.address, srcUsdc, dstUsdc,
                usdcReceived, quote.outputAmount, dstChainId,
                quote.exclusiveRelayer, quote.timestamp || quote.quoteTimestamp,
                quote.fillDeadline, quote.exclusivityDeadline || 0, '0x',
                { gasLimit: 300000, ...overrides }
            );
            await bridgeTx.wait();

            const usdcOut = parseFloat(ethers.utils.formatUnits(usdcReceived, 6)).toFixed(2);
            return { hash: bridgeTx.hash, amount: usdcOut, token: 'USDC' };
        }

        // ── USDC / WETH paths (unchanged) ──
        let inputToken, outputToken, decimals;
        if (tokenKey === 'usdc') {
            inputToken = srcNet.usdc;
            outputToken = dstNet.usdc;
            if (fromKey === 'polygon') {
                const nativeUsdcAddr = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
                const nativeUsdc = new ethers.Contract(nativeUsdcAddr, ['function balanceOf(address) view returns (uint256)'], signer);
                const nativeBal = await nativeUsdc.balanceOf(wallet.address);
                const amountUnits = ethers.utils.parseUnits(amountStr, 6);
                if (nativeBal.gte(amountUnits)) inputToken = nativeUsdcAddr;
            }
            decimals = fromKey === 'bsc' ? 18 : 6;
        } else if (tokenKey === 'weth') {
            inputToken = srcNet.weth;
            outputToken = dstNet.weth;
            decimals = 18;
        } else {
            return { error: 'Unsupported token for custom bridge' };
        }
        
        const amountUnits = ethers.utils.parseUnits(amountStr, decimals);
        const tokenContract = new ethers.Contract(inputToken, ERC20_ABI_BRIDGE, signer);
        const bal = await tokenContract.balanceOf(wallet.address);
        
        if (bal.lt(amountUnits)) {
            return { error: `Not enough ${tokenKey.toUpperCase()} on ${srcNet.name}. Have: ${ethers.utils.formatUnits(bal, decimals)}` };
        }
        
        if (fromKey === 'bsc') {
            if (tokenKey !== 'usdc') return { error: 'BSC bridging only supports USDC' };
            const getDeBridgeDlnTx = (amt) => new Promise((resolve, reject) => {
                const url = `https://dln.debridge.finance/v1.0/dln/order/create-tx?srcChainId=56&srcChainTokenIn=${inputToken}&srcChainTokenInAmount=${amt}&dstChainId=${dstChainId}&dstChainTokenOut=${outputToken}&dstChainTokenOutAmount=auto&dstChainTokenOutRecipient=${wallet.address}&srcChainOrderAuthorityAddress=${wallet.address}&dstChainOrderAuthorityAddress=${wallet.address}`;
                https.get(url, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{ const j=JSON.parse(d); (!j.tx)?reject(new Error(j.message||'deBridge Error')):resolve(j.tx); }catch(e){reject(e);} }); }).on('error',reject);
            });
            const deBridgeTx = await getDeBridgeDlnTx(amountUnits.toString());
            const approveTx = await tokenContract.approve(deBridgeTx.to, amountUnits);
            await approveTx.wait();
            const tx = await signer.sendTransaction({ to: deBridgeTx.to, data: deBridgeTx.data, value: deBridgeTx.value ? ethers.BigNumber.from(deBridgeTx.value) : 0, gasLimit: 350000 });
            await tx.wait();
            return { hash: tx.hash, amount: amountStr, token: 'USDC' };
        }
        
        const spokePools = { base: '0x090C53Ed1dEaf056ca7f193563914A4237D0c0c7', polygon: '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096', arbitrum: '0xe35E9842A20b3205E324596763e4Ad8060c1BC27', optimism: '0x6F26Df09F98a26DBD8F8A2088E0285A21406352f', linea: '0x7e63A5f187313386e8A9d31195A624b51458eE75' };
        const spokePoolAddr = spokePools[fromKey];

        let quote;
        try {
            quote = await new Promise((resolve, reject) => {
                const url = `https://across.to/api/suggested-fees?inputToken=${inputToken}&outputToken=${outputToken}&originChainId=${srcChainId}&destinationChainId=${dstChainId}&amount=${amountUnits}`;
                https.get(url, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{ const j=JSON.parse(d); j.error?reject(new Error(j.message)):resolve(j); }catch(e){reject(e);} }); }).on('error',reject);
            });
        } catch (e) {
            quote = { spokePoolAddress: spokePoolAddr, outputAmount: amountUnits.mul(99).div(100).toString(), quoteTimestamp: Math.floor(Date.now()/1000), exclusiveRelayer: '0x0000000000000000000000000000000000000000', exclusivityDeadline: 0, fillDeadline: Math.floor(Date.now()/1000)+7200 };
        }
        
        const activeSpokePool = quote.spokePoolAddress || spokePoolAddr;
        const approveTx = await tokenContract.approve(activeSpokePool, amountUnits, overrides);
        await approveTx.wait();

        const spokePool = new ethers.Contract(activeSpokePool, SPOKE_POOL_ABI, signer);
        const bridgeTx = await spokePool.depositV3(
            wallet.address, wallet.address, inputToken, outputToken,
            amountUnits, quote.outputAmount, dstChainId,
            quote.exclusiveRelayer, quote.timestamp || quote.quoteTimestamp,
            quote.fillDeadline, quote.exclusivityDeadline || 0, '0x',
            { gasLimit: 300000, ...overrides }
        );
        await bridgeTx.wait();
        return { hash: bridgeTx.hash, amount: amountStr, token: tokenKey.toUpperCase() };

    } catch (e) {
        return { error: 'Bridge failed: ' + e.message };
    }
});

// =============================================================================
// EXPORT PRIVATE KEY — wallet must be unlocked (password or PIN)
// =============================================================================
ipcMain.handle('wallet:exportKey', () => {
    if (!wallet) return { error: 'Wallet not unlocked. Unlock with PIN or password first.' };
    return { privateKey: wallet.privateKey, address: wallet.address };
});

// =============================================================================
// EXPORT PRIVATE KEY WITH PASSWORD — re-decrypts from stored envelope
// Works even if wallet is currently locked
// =============================================================================
ipcMain.handle('wallet:exportKeyWithPassword', (_, password) => {
    try {
        const store = loadStore();
        if (!store) return { error: 'No wallet found' };
        const privateKey = decryptPwEnvelope(store.pwEnvelope, password);
        // Verify it's a valid key
        const w = new ethers.Wallet(privateKey);
        return { privateKey, address: w.address };
    } catch (e) {
        return { error: 'Wrong password or corrupt wallet' };
    }
});


// =============================================================================
// ADDRESS BOOK
// =============================================================================
ipcMain.handle('wallet:getAddressBook', () => {
    try {
        const store = loadStore() || {};
        return store.addressBook || [];
    } catch (e) { return []; }
});

ipcMain.handle('wallet:saveAddress', (_, label, address) => {
    try {
        const store = loadStore();
        if (!store) return { error: 'No wallet found' };
        if (!store.addressBook) store.addressBook = [];
        // Prevent duplicate addresses (case insensitive)
        store.addressBook = store.addressBook.filter(item => item.address.toLowerCase() !== address.toLowerCase());
        store.addressBook.push({ label, address });
        saveStore(store);
        return { ok: true, addressBook: store.addressBook };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('wallet:deleteAddress', (_, address) => {
    try {
        const store = loadStore();
        if (!store) return { error: 'No wallet found' };
        if (!store.addressBook) store.addressBook = [];
        store.addressBook = store.addressBook.filter(item => item.address.toLowerCase() !== address.toLowerCase());
        saveStore(store);
        return { ok: true, addressBook: store.addressBook };
    } catch (e) { return { error: e.message }; }
});

// =============================================================================
// MULTI-CHAIN RELAY DEPLOYMENT & BRIDGING AUTOMATION
// =============================================================================



const SPOKE_POOL_ABI = [
    'function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes calldata message) external payable'
];

const ERC20_ABI_BRIDGE = [
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function balanceOf(address account) external view returns (uint256)',
    'function transfer(address to, uint256 amount) external returns (bool)'
];

const ROUTER_ABI_BRIDGE = [
    'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) external returns (uint256[] memory amounts)',
    'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) external payable returns (uint256[] memory amounts)',
    'function getAmountsOut(uint256 amountIn, address[] path) external view returns (uint256[] memory amounts)'
];

async function deployNetworkHelper(networkKey) {
    if (!wallet) return { error: 'Wallet not unlocked' };
    const store = loadStore() || {};

    const hardhatDir = path.join(__dirname, 'hardhat-env');
    const envPath = path.join(hardhatDir, '.env');
    const { exec } = require('child_process');

    const pk = wallet.privateKey;
    const networkMap = {
        base: 'baseMainnet',
        polygon: 'polygonMainnet',
        arbitrum: 'arbitrumMainnet',
        optimism: 'optimismMainnet',
        bsc: 'bscMainnet',
        linea: 'lineaMainnet'
    };

    const hardhatNetwork = networkMap[networkKey];
    if (!hardhatNetwork) return { error: 'Unsupported network: ' + networkKey };

    // Write a temporary .env file with developer credentials
    const envContent = `DEPLOYER_PRIVATE_KEY=${pk}\nTREASURY_ADDRESS=${wallet.address}\n`;
    try {
        fs.writeFileSync(envPath, envContent);
    } catch (e) {
        return { error: 'Failed to write temporary deployment configuration: ' + e.message };
    }

    return new Promise((resolve) => {
        exec(`npx hardhat run scripts/deploy-uniswap-v3-relay.ts --network ${hardhatNetwork}`, { cwd: hardhatDir }, (err, stdout, stderr) => {
            // Guarantee cleanup of the temporary .env file containing the plaintext key
            try {
                if (fs.existsSync(envPath)) {
                    fs.unlinkSync(envPath);
                }
            } catch (unlinkErr) {
                console.error('Failed to remove temporary configuration:', unlinkErr);
            }

            if (err) {
                resolve({ error: 'Deployment execution failed:\n' + (stderr || err.message) + '\nOutput:\n' + stdout });
                return;
            }

            // Parse output for successful deployment message containing contract addresses
            const match = stdout.match(/DEPLOYMENT_SUCCESS:\s*relay=(0x[a-fA-F0-9]{40})\s*proxy=(0x[a-fA-F0-9]{40})/i);
            if (match) {
                const relayAddress = match[1];
                const proxyAddress = match[2];

                // Persist the deployed contract addresses in the wallet store
                const storeKeyRelay = networkKey + 'Relay';
                const storeKeyProxy = networkKey + 'Proxy';
                store[storeKeyRelay] = relayAddress;
                store[storeKeyProxy] = proxyAddress;
                saveStore(store);

                // Update in-memory configuration
                if (NETWORKS[networkKey]) {
                    NETWORKS[networkKey].relay = relayAddress;
                    NETWORKS[networkKey].proxy = proxyAddress;
                }

                resolve({ ok: true, relay: relayAddress, proxy: proxyAddress });
            } else {
                resolve({ error: 'Deployment finished but contract addresses could not be parsed. Output:\n' + stdout });
            }
        });
    });
}

ipcMain.handle('wallet:deployPolygon', () => deployNetworkHelper('polygon'));
ipcMain.handle('wallet:deployNetwork', (_, networkKey) => deployNetworkHelper(networkKey));

ipcMain.handle('wallet:bridgePolygonToBase', async () => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    const https = require('https');

    const getAcrossSuggestedFees = (amountWei) => {
        return new Promise((resolve, reject) => {
            const inputToken = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
            const outputToken = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
            const url = `https://across.to/api/suggested-fees?inputToken=${inputToken}&outputToken=${outputToken}&originChainId=137&destinationChainId=8453&amount=${amountWei}`;
            
            https.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.error || json.type === 'AcrossApiError') {
                            reject(new Error(json.message || 'Across API Error'));
                        } else {
                            resolve(json);
                        }
                    } catch (e) {
                        reject(new Error('Failed to parse Across fee response'));
                    }
                });
            }).on('error', err => reject(err));
        });
    };

    try {
        const polyProv = providers.polygon;
        const signer = wallet.connect(polyProv);
        const overrides = await getPolygonGasOverrides(polyProv);

        const wethAddr = '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619';
        const usdcEAddr = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        const nativeUsdcAddr = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
        const polyRouterAddr = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';
        const spokePoolAddr = '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096';
        const wpolAddr = '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270';

        const wethContract = new ethers.Contract(wethAddr, ERC20_ABI_BRIDGE, signer);
        const usdcEContract = new ethers.Contract(usdcEAddr, ERC20_ABI_BRIDGE, signer);
        const nativeUsdcContract = new ethers.Contract(nativeUsdcAddr, ERC20_ABI_BRIDGE, signer);

        const routerContract = new ethers.Contract(polyRouterAddr, ROUTER_ABI_BRIDGE, signer);

        const txs = [];

        // Step 1: Swap WETH -> USDC.e (Safeguard: only swap if above 0.0001 WETH dust threshold)
        let wethBal = await wethContract.balanceOf(wallet.address);
        const minWethToSwap = ethers.utils.parseEther("0.0001");
        if (wethBal.gt(minWethToSwap)) {
            try {
                const approveTx = await wethContract.approve(polyRouterAddr, wethBal, overrides);
                await approveTx.wait();

                const deadline = Math.floor(Date.now() / 1000) + 300;
                const path = [wethAddr, usdcEAddr];
                const swapTx = await routerContract.swapExactTokensForTokens(
                    wethBal, 0, path, wallet.address, deadline,
                    { gasLimit: 250000, ...overrides }
                );
                await swapTx.wait();
                txs.push({ step: 'swap_weth', hash: swapTx.hash });
            } catch (e) {
                console.error("Polygon WETH swap failed, continuing sequence...", e);
            }
        }

        // Step 2: Swap POL -> USDC.e leaving 0.5 POL gas buffer (POL gas costs fractions of a cent)
        const polBal = await polyProv.getBalance(wallet.address);
        const gasBuffer = ethers.utils.parseEther("0.5");
        const minPolToSwap = ethers.utils.parseEther("0.05");
        if (polBal.gt(gasBuffer.add(minPolToSwap))) {
            try {
                const swapAmount = polBal.sub(gasBuffer);
                const path = [wpolAddr, usdcEAddr];
                const deadline = Math.floor(Date.now() / 1000) + 300;

                const swapTx = await routerContract.swapExactETHForTokens(
                    0, path, wallet.address, deadline,
                    { value: swapAmount, gasLimit: 250000, ...overrides }
                );
                await swapTx.wait();
                txs.push({ step: 'swap_pol', hash: swapTx.hash });
            } catch (e) {
                console.error("Polygon POL sweep failed, continuing sequence...", e);
            }
        }

        // Step 3: Swap USDC.e (bridged) -> native USDC on Polygon via Uniswap V3 Router
        let usdcEBal = await usdcEContract.balanceOf(wallet.address);
        if (usdcEBal.gt(0)) {
            const uniV3RouterAddr = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
            // SwapRouter02 drops `deadline` from the struct; SwapRouter v1 keeps it
            const routerABI = NETWORKS.polygon.routerV2
                ? ['function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256)']
                : ['function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256)'];
            const uniV3Router = new ethers.Contract(uniV3RouterAddr, routerABI, signer);
            const deadline = Math.floor(Date.now() / 1000) + 600;
            
            try {
                const approveTx = await usdcEContract.approve(uniV3RouterAddr, usdcEBal, overrides);
                await approveTx.wait();

                let swapTx;
                try {
                    // Try 0.01% fee tier pool first (standard for stable pairs)
                    swapTx = await uniV3Router.exactInputSingle({
                        tokenIn: usdcEAddr,
                        tokenOut: nativeUsdcAddr,
                        fee: 100, // 0.01%
                        recipient: wallet.address,
                        deadline: deadline,
                        amountIn: usdcEBal,
                        amountOutMinimum: usdcEBal.mul(99).div(100), // 1% slippage limit
                        sqrtPriceLimitX96: 0
                    }, { gasLimit: 250000, ...overrides });
                    await swapTx.wait();
                    txs.push({ step: 'swap_usdc_e_001', hash: swapTx.hash });
                } catch (err) {
                    // Fallback to 0.05% fee tier pool
                    swapTx = await uniV3Router.exactInputSingle({
                        tokenIn: usdcEAddr,
                        tokenOut: nativeUsdcAddr,
                        fee: 500, // 0.05%
                        recipient: wallet.address,
                        deadline: deadline,
                        amountIn: usdcEBal,
                        amountOutMinimum: usdcEBal.mul(99).div(100),
                        sqrtPriceLimitX96: 0
                    }, { gasLimit: 250000, ...overrides });
                    await swapTx.wait();
                    txs.push({ step: 'swap_usdc_e_005', hash: swapTx.hash });
                }
            } catch (e) {
                console.error("Polygon USDC.e stable swap failed, continuing sequence...", e);
            }
        }

        // Step 4: Bridge native USDC -> Base USDC
        let nativeUsdcBal = await nativeUsdcContract.balanceOf(wallet.address);
        if (nativeUsdcBal.eq(0)) {
            if (txs.length > 0) {
                return { ok: true, txs: txs, amount: '0 (Swaps completed but no USDC to bridge)' };
            }
            return { error: 'You have no assets (WETH, POL, USDC.e, or USDC) on Polygon to bridge.' };
        }

        // Fetch quote from Across suggested fees API
        let quote;
        try {
            quote = await getAcrossSuggestedFees(nativeUsdcBal.toString());
        } catch (e) {
            // Fallback parameters if Across API fails
            quote = {
                spokePoolAddress: spokePoolAddr,
                outputAmount: nativeUsdcBal.mul(99).div(100).toString(), // 1% fallback fee
                quoteTimestamp: Math.floor(Date.now() / 1000),
                exclusiveRelayer: '0x0000000000000000000000000000000000000000',
                exclusivityDeadline: 0,
                fillDeadline: Math.floor(Date.now() / 1000) + 7200
            };
        }

        // Approve Across SpokePool to pull native USDC
        const activeSpokePool = quote.spokePoolAddress || spokePoolAddr;
        const approveSpokeTx = await nativeUsdcContract.approve(activeSpokePool, nativeUsdcBal, overrides);
        await approveSpokeTx.wait();

        // Call depositV3 to bridge Polygon USDC -> Base USDC
        const spokePoolContract = new ethers.Contract(activeSpokePool, SPOKE_POOL_ABI, signer);
        const bridgeTx = await spokePoolContract.depositV3(
            wallet.address, // depositor
            wallet.address, // recipient
            nativeUsdcAddr, // inputToken (Polygon native USDC)
            '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // outputToken (Base native USDC)
            nativeUsdcBal, // inputAmount
            quote.outputAmount, // outputAmount (received on Base)
            8453, // destinationChainId (Base Chain ID)
            quote.exclusiveRelayer, // exclusiveRelayer
            quote.timestamp || quote.quoteTimestamp, // quoteTimestamp
            quote.fillDeadline, // fillDeadline
            quote.exclusivityDeadline || 0, // exclusivityDeadline
            '0x', // message (empty)
            { gasLimit: 250000, ...overrides }
        );
        await bridgeTx.wait();
        txs.push({ step: 'bridge', hash: bridgeTx.hash });

        return { ok: true, txs: txs, amount: ethers.utils.formatUnits(nativeUsdcBal, 6) };
    } catch (e) {
        return { error: 'Automated bridge sequence failed: ' + e.message };
    }
});

async function bridgeEvmChainToBase(networkKey) {
    if (!wallet) return { error: 'Wallet not unlocked' };
    const https = require('https');

    const getAcrossSuggestedFees = (amountWei, inputToken, originChainId) => {
        return new Promise((resolve, reject) => {
            const outputToken = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
            const url = `https://across.to/api/suggested-fees?inputToken=${inputToken}&outputToken=${outputToken}&originChainId=${originChainId}&destinationChainId=8453&amount=${amountWei}`;
            
            https.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.error || json.type === 'AcrossApiError') {
                            reject(new Error(json.message || 'Across API Error'));
                        } else {
                            resolve(json);
                        }
                    } catch (e) {
                        reject(new Error('Failed to parse Across fee response'));
                    }
                });
            }).on('error', err => reject(err));
        });
    };

    try {
        const net = NETWORKS[networkKey];
        const prov = providers[networkKey];
        const signer = wallet.connect(prov);
        
        const CHAIN_CONFIG = {
            arbitrum: { chainId: 42161, spokePool: '0xe35E9842A20b3205E324596763e4Ad8060c1BC27' },
            optimism: { chainId: 10,    spokePool: '0xa420b2d1c0841415A695b81E5B867BCD07Dff8C9' }, // verified Optimism SpokePool
            polygon:  { chainId: 137,   spokePool: '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096' },
            linea:    { chainId: 59144, spokePool: '0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75' },
        };
        const chainId      = CHAIN_CONFIG[networkKey]?.chainId      || 10;
        const spokePoolAddr = CHAIN_CONFIG[networkKey]?.spokePool   || '0xa420b2d1c0841415a695b81e5b867bcd07dff8c9';

        const wethContract = new ethers.Contract(net.weth, ERC20_ABI_BRIDGE, signer);
        const usdcContract = new ethers.Contract(net.usdc, ERC20_ABI_BRIDGE, signer);
        // SwapRouter02 (Optimism, Linea) omits deadline; SwapRouter v1 (Arbitrum) keeps it
        const routerABI = net.routerV2
            ? ['function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256)']
            : ['function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256)'];
        const routerContract = new ethers.Contract(net.router, routerABI, signer);

        const txs = [];

        // Step 1: Swap WETH -> USDC
        let wethBal = await wethContract.balanceOf(wallet.address);
        if (wethBal.gt(0)) {
            try {
                const approveTx = await wethContract.approve(net.router, wethBal);
                await approveTx.wait();

                const deadline = Math.floor(Date.now() / 1000) + 600;
                const swapTx = await routerContract.exactInputSingle({
                    tokenIn: net.weth,
                    tokenOut: net.usdc,
                    fee: 500, // 0.05% fee pool standard
                    recipient: wallet.address,
                    deadline: deadline,
                    amountIn: wethBal,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                }, { gasLimit: 250000 });
                await swapTx.wait();
                txs.push({ step: 'swap_weth', hash: swapTx.hash });
            } catch (e) {
                console.error(`${net.name} WETH swap failed, continuing sequence...`, e);
            }
        }

        // Step 2: Swap ETH -> USDC leaving 0.0005 ETH gas buffer (L2 gas is cents, not dollars)
        const ethBal = await prov.getBalance(wallet.address);
        const gasBuffer = ethers.utils.parseEther("0.0005");
        if (ethBal.gt(gasBuffer)) {
            try {
                const swapAmount = ethBal.sub(gasBuffer);
                // Wrap ETH -> WETH first
                const wethWrapABI = ['function deposit() payable'];
                const wethWrap = new ethers.Contract(net.weth, wethWrapABI, signer);
                const wrapTx = await wethWrap.deposit({ value: swapAmount });
                await wrapTx.wait();

                // Approve router for swapAmount
                const approveTx = await wethContract.approve(net.router, swapAmount);
                await approveTx.wait();

                // Try fee tiers: 0.05% -> 0.3% -> 1%
                const deadline = Math.floor(Date.now() / 1000) + 600;
                let swapTx;
                for (const fee of [500, 3000, 10000]) {
                    try {
                        // SwapRouter02 omits deadline from the struct
                        const params = net.routerV2
                            ? { tokenIn: net.weth, tokenOut: net.usdc, fee, recipient: wallet.address, amountIn: swapAmount, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }
                            : { tokenIn: net.weth, tokenOut: net.usdc, fee, recipient: wallet.address, deadline, amountIn: swapAmount, amountOutMinimum: 0, sqrtPriceLimitX96: 0 };
                        swapTx = await routerContract.exactInputSingle(params, { gasLimit: 350000 });
                        await swapTx.wait();
                        txs.push({ step: `swap_eth_fee${fee}`, hash: swapTx.hash });
                        break;
                    } catch (feeErr) {
                        console.error(`${net.name} swap fee=${fee} failed:`, feeErr.message);
                    }
                }
            } catch (e) {
                console.error(`${net.name} ETH wrap/swap failed:`, e.message);
            }
        }

        // Step 3: Bridge native USDC -> Base USDC
        let usdcBal = await usdcContract.balanceOf(wallet.address);
        if (usdcBal.eq(0)) {
            if (txs.length > 0) {
                return { ok: true, txs: txs, amount: '0 (Swaps completed but no USDC to bridge)' };
            }
            return { error: `You have no assets (WETH, ETH, or USDC) on ${net.name} to bridge.` };
        }

        // Fetch Across suggested fee quote
        let quote;
        try {
            quote = await getAcrossSuggestedFees(usdcBal.toString(), net.usdc, chainId);
        } catch (e) {
            quote = {
                spokePoolAddress: spokePoolAddr,
                outputAmount: usdcBal.mul(99).div(100).toString(), // 1% fee fallback
                quoteTimestamp: Math.floor(Date.now() / 1000),
                exclusiveRelayer: '0x0000000000000000000000000000000000000000',
                exclusivityDeadline: 0,
                fillDeadline: Math.floor(Date.now() / 1000) + 7200
            };
        }

        const activeSpokePool = quote.spokePoolAddress || spokePoolAddr;
        const approveSpokeTx = await usdcContract.approve(activeSpokePool, usdcBal);
        await approveSpokeTx.wait();

        const spokePoolContract = new ethers.Contract(activeSpokePool, SPOKE_POOL_ABI, signer);
        const bridgeTx = await spokePoolContract.depositV3(
            wallet.address, // depositor
            wallet.address, // recipient
            net.usdc, // inputToken
            '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // outputToken (Base USDC)
            usdcBal, // inputAmount
            quote.outputAmount, // outputAmount
            8453, // destinationChainId
            quote.exclusiveRelayer,
            quote.timestamp || quote.quoteTimestamp,
            quote.fillDeadline,
            quote.exclusivityDeadline || 0,
            '0x',
            { gasLimit: 250000 }
        );
        await bridgeTx.wait();
        txs.push({ step: 'bridge', hash: bridgeTx.hash });

        return { ok: true, txs: txs, amount: ethers.utils.formatUnits(usdcBal, 6) };
    } catch (e) {
        return { error: `Automated bridge sequence failed: ${e.message}` };
    }
}

async function bridgeBscToBase() {
    if (!wallet) return { error: 'Wallet not unlocked' };
    const https = require('https');

    const getDeBridgeDlnTx = (amountWei) => {
        return new Promise((resolve, reject) => {
            const srcToken = '0x8AC76a51cc950d9822D68b83fE1Ad97B32CD580d';
            const dstToken = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
            const userAddr = wallet.address;
            const url = `https://dln.debridge.finance/v1.0/dln/order/create-tx?srcChainId=56&srcChainTokenIn=${srcToken}&srcChainTokenInAmount=${amountWei}&dstChainId=8453&dstChainTokenOut=${dstToken}&dstChainTokenOutAmount=auto&dstChainTokenOutRecipient=${userAddr}&srcChainOrderAuthorityAddress=${userAddr}&dstChainOrderAuthorityAddress=${userAddr}`;
            
            https.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.error || !json.tx) {
                            reject(new Error(json.message || 'deBridge API Error'));
                        } else {
                            resolve(json.tx);
                        }
                    } catch (e) {
                        reject(new Error('Failed to parse deBridge DLN response'));
                    }
                });
            }).on('error', err => reject(err));
        });
    };

    try {
        const net = NETWORKS.bsc;
        const prov = providers.bsc;
        const signer = wallet.connect(prov);

        const wethContract = new ethers.Contract(net.weth, ERC20_ABI_BRIDGE, signer);
        const usdcContract = new ethers.Contract(net.usdc, ERC20_ABI_BRIDGE, signer);
        const routerContract = new ethers.Contract(net.router, [
            'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256)'
        ], signer);

        const txs = [];

        // Step 1: Swap WBNB -> USDC (0.05% fee pool standard on PancakeSwap V3)
        let wethBal = await wethContract.balanceOf(wallet.address);
        if (wethBal.gt(0)) {
            try {
                const approveTx = await wethContract.approve(net.router, wethBal);
                await approveTx.wait();

                const deadline = Math.floor(Date.now() / 1000) + 600;
                const swapTx = await routerContract.exactInputSingle({
                    tokenIn: net.weth,
                    tokenOut: net.usdc,
                    fee: 500,
                    recipient: wallet.address,
                    deadline: deadline,
                    amountIn: wethBal,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                }, { gasLimit: 250000 });
                await swapTx.wait();
                txs.push({ step: 'swap_weth', hash: swapTx.hash });
            } catch (e) {
                console.error("BSC WBNB swap failed, continuing sequence...", e);
            }
        }

        // Step 2: Swap BNB -> USDC leaving 0.005 BNB gas buffer
        const bnbBal = await prov.getBalance(wallet.address);
        const gasBuffer = ethers.utils.parseEther("0.005");
        if (bnbBal.gt(gasBuffer)) {
            try {
                const swapAmount = bnbBal.sub(gasBuffer);
                // Wrap BNB -> WBNB
                const wbnbWrap = new ethers.Contract(net.weth, ['function deposit() payable'], signer);
                const wrapTx = await wbnbWrap.deposit({ value: swapAmount });
                await wrapTx.wait();

                // Swap WBNB -> USDC
                const approveTx = await wethContract.approve(net.router, swapAmount);
                await approveTx.wait();

                const deadline = Math.floor(Date.now() / 1000) + 600;
                const swapTx = await routerContract.exactInputSingle({
                    tokenIn: net.weth,
                    tokenOut: net.usdc,
                    fee: 500,
                    recipient: wallet.address,
                    deadline: deadline,
                    amountIn: swapAmount,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                }, { gasLimit: 250000 });
                await swapTx.wait();
                txs.push({ step: 'swap_bnb', hash: swapTx.hash });
            } catch (e) {
                console.error("BSC BNB sweep failed, continuing sequence...", e);
            }
        }

        // Step 3: Bridge native USDC -> Base USDC via deBridge
        let usdcBal = await usdcContract.balanceOf(wallet.address);
        if (usdcBal.eq(0)) {
            if (txs.length > 0) {
                return { ok: true, txs: txs, amount: '0 (Swaps completed but no USDC to bridge)' };
            }
            return { error: 'You have no assets (WBNB, BNB, or USDC) on BSC to bridge.' };
        }

        // Fetch transaction payload from deBridge API
        const deBridgeTx = await getDeBridgeDlnTx(usdcBal.toString());
        
        // Approve deBridge contract to pull USDC
        const approveBridgeTx = await usdcContract.approve(deBridgeTx.to, usdcBal);
        await approveBridgeTx.wait();

        // Send DLN transaction to execute cross-chain trade
        const bridgeTx = await signer.sendTransaction({
            to: deBridgeTx.to,
            data: deBridgeTx.data,
            value: deBridgeTx.value, // contains native fee
            gasLimit: 300000
        });
        await bridgeTx.wait();
        txs.push({ step: 'bridge', hash: bridgeTx.hash });

        return { ok: true, txs: txs, amount: ethers.utils.formatUnits(usdcBal, 18) }; // BSC USDC uses 18 decimals
    } catch (e) {
        return { error: 'Automated bridge sequence failed: ' + e.message };
    }
}

ipcMain.handle('wallet:bridgeArbitrumToBase', async () => {
    return await bridgeEvmChainToBase('arbitrum');
});

ipcMain.handle('wallet:bridgeOptimismToBase', async () => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    const https = require('https');

    const OPT_WETH     = '0x4200000000000000000000000000000000000006';
    const OPT_USDCE    = '0x7F5c764cBc14f9669B88837ca1490cCa17c31607'; // USDC.e — deep Uniswap V3 liquidity
    const OPT_ROUTER   = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'; // SwapRouter02
    const OPT_SPOKE    = '0xa420b2d1c0841415A695b81E5B867BCD07Dff8C9';
    const BASE_USDC    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

    const prov   = providers.optimism;
    const signer = wallet.connect(prov);

    // SwapRouter02 ABI (no deadline in struct)
    const ROUTER_ABI = ['function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256)'];
    const router      = new ethers.Contract(OPT_ROUTER, ROUTER_ABI, signer);
    const wethContract = new ethers.Contract(OPT_WETH, ERC20_ABI_BRIDGE, signer);
    const usdceContract = new ethers.Contract(OPT_USDCE, ERC20_ABI_BRIDGE, signer);

    try {
        const txs = [];

        // Step 1: Swap any existing WETH → USDC.e (picks up stuck WETH from prior failed runs)
        const wethBal = await wethContract.balanceOf(wallet.address);
        if (wethBal.gt(0)) {
            try {
                const approveTx = await wethContract.approve(OPT_ROUTER, wethBal, { gasLimit: 80000 });
                await approveTx.wait();
                for (const fee of [500, 3000]) {
                    try {
                        const swapTx = await router.exactInputSingle(
                            { tokenIn: OPT_WETH, tokenOut: OPT_USDCE, fee, recipient: wallet.address, amountIn: wethBal, amountOutMinimum: 0, sqrtPriceLimitX96: 0 },
                            { gasLimit: 350000 }
                        );
                        await swapTx.wait();
                        txs.push({ step: `swap_weth_usdce_${fee}`, hash: swapTx.hash });
                        break;
                    } catch(fe) { console.error(`Optimism WETH→USDC.e fee=${fee}:`, fe.message); }
                }
            } catch(e) { console.error('Optimism WETH step failed:', e.message); }
        }

        // Step 2: Wrap remaining ETH → WETH → USDC.e
        const ethBal    = await prov.getBalance(wallet.address);
        const gasBuffer = ethers.utils.parseEther('0.0001'); // very small buffer, gas is cheap on Optimism
        if (ethBal.gt(gasBuffer)) {
            const swapAmount = ethBal.sub(gasBuffer);
            try {
                const wethWrap = new ethers.Contract(OPT_WETH, ['function deposit() payable'], signer);
                const wrapTx = await wethWrap.deposit({ value: swapAmount, gasLimit: 80000 });
                await wrapTx.wait();
                const approveWrap = await wethContract.approve(OPT_ROUTER, swapAmount, { gasLimit: 80000 });
                await approveWrap.wait();
                for (const fee of [500, 3000]) {
                    try {
                        const swapTx = await router.exactInputSingle(
                            { tokenIn: OPT_WETH, tokenOut: OPT_USDCE, fee, recipient: wallet.address, amountIn: swapAmount, amountOutMinimum: 0, sqrtPriceLimitX96: 0 },
                            { gasLimit: 350000 }
                        );
                        await swapTx.wait();
                        txs.push({ step: `swap_eth_usdce_${fee}`, hash: swapTx.hash });
                        break;
                    } catch(fe) { console.error(`Optimism ETH→USDC.e fee=${fee}:`, fe.message); }
                }
            } catch(e) { console.error('Optimism ETH wrap step failed:', e.message); }
        }

        // Step 3: Bridge USDC.e → Base USDC via Across
        const usdceBal = await usdceContract.balanceOf(wallet.address);
        if (usdceBal.eq(0)) {
            if (txs.length > 0) return { ok: true, txs, amount: '0 (swaps done, no USDC.e to bridge)' };
            return { error: 'No WETH or ETH on Optimism to bridge.' };
        }

        let quote;
        try {
            quote = await new Promise((resolve, reject) => {
                const url = `https://across.to/api/suggested-fees?inputToken=${OPT_USDCE}&outputToken=${BASE_USDC}&originChainId=10&destinationChainId=8453&amount=${usdceBal}`;
                https.get(url, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(e);} }); }).on('error', reject);
            });
        } catch(e) {
            quote = { spokePoolAddress: OPT_SPOKE, outputAmount: usdceBal.mul(99).div(100), quoteTimestamp: Math.floor(Date.now()/1000), exclusiveRelayer: ethers.constants.AddressZero, exclusivityDeadline: 0, fillDeadline: Math.floor(Date.now()/1000)+7200 };
        }

        const activeSpokePool = quote.spokePoolAddress || OPT_SPOKE;
        await (await usdceContract.approve(activeSpokePool, usdceBal)).wait();
        const spokePool = new ethers.Contract(activeSpokePool, SPOKE_POOL_ABI, signer);
        const bridgeTx = await spokePool.depositV3(
            wallet.address, wallet.address, OPT_USDCE, BASE_USDC, usdceBal, quote.outputAmount, 8453,
            quote.exclusiveRelayer, quote.timestamp || quote.quoteTimestamp, quote.fillDeadline, quote.exclusivityDeadline || 0, '0x',
            { gasLimit: 300000 }
        );
        await bridgeTx.wait();
        txs.push({ step: 'bridge', hash: bridgeTx.hash });
        return { ok: true, txs, amount: ethers.utils.formatUnits(usdceBal, 6) };
    } catch(e) {
        return { error: 'Optimism bridge failed: ' + e.message };
    }
});

ipcMain.handle('wallet:bridgeBscToBase', async () => {
    return await bridgeBscToBase();
});

ipcMain.handle('wallet:bridgeLineaToBase', async () => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    const https = require('https');

    const SYNCSWAP_FACTORY = '0x37BAc764494c8db4e54BDE72f6965beA9fa0AC2d';
    const SYNCSWAP_ROUTER  = '0xC2a1947d2336b2AF74d5813dC9cA6E0c3b3E8a1E';
    const LINEA_WETH       = '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f';
    const LINEA_USDC       = '0x176211869cA2b568f2A7D4EE941E073a821EE1ff';
    const LINEA_SPOKE_POOL = '0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75';
    const BASE_USDC        = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

    const prov   = providers.linea;
    const signer = wallet.connect(prov);

    try {
        const txs = [];

        // ── Step 1: Swap native ETH → USDC via SyncSwap (no wrap needed) ──
        const ethBal    = await prov.getBalance(wallet.address);
        const gasBuffer = ethers.utils.parseEther('0.0005');

        if (ethBal.gt(gasBuffer)) {
            const swapAmount = ethBal.sub(gasBuffer);

            // Look up the WETH/USDC classic pool
            const factory = new ethers.Contract(
                SYNCSWAP_FACTORY,
                ['function getPool(address,address) view returns (address)'],
                prov
            );
            const poolAddress = await factory.getPool(LINEA_WETH, LINEA_USDC);

            if (poolAddress && poolAddress !== ethers.constants.AddressZero) {
                try {
                    // Wrap ETH → WETH first (ERC20 path is more reliable than native ETH path)
                    const wethWrap = new ethers.Contract(LINEA_WETH, ['function deposit() payable', 'function approve(address,uint256) returns (bool)'], signer);
                    const wrapTx = await wethWrap.deposit({ value: swapAmount, gasLimit: 80000 });
                    await wrapTx.wait();

                    // Approve SyncSwap router for WETH
                    const approveTx = await wethWrap.approve(SYNCSWAP_ROUTER, swapAmount, { gasLimit: 80000 });
                    await approveTx.wait();

                    // Encode step data: pool input token = WETH, recipient, withdrawMode = 2 (ERC20 out)
                    const swapData = ethers.utils.defaultAbiCoder.encode(
                        ['address', 'address', 'uint8'],
                        [LINEA_WETH, wallet.address, 2]
                    );

                    // Use WETH as ERC20 tokenIn (no msg.value needed)
                    const paths = [{
                        steps: [{ pool: poolAddress, data: swapData, callback: ethers.constants.AddressZero, callbackData: '0x' }],
                        tokenIn: LINEA_WETH,
                        amountIn: swapAmount
                    }];

                    const ROUTER_ABI = [
                        'function swap(tuple(tuple(address pool, bytes data, address callback, bytes callbackData)[] steps, address tokenIn, uint256 amountIn)[] paths, uint256 amountOutMin, uint256 deadline) external payable returns (tuple(address token, uint256 amount)[] amountOut)'
                    ];
                    const router   = new ethers.Contract(SYNCSWAP_ROUTER, ROUTER_ABI, signer);
                    const deadline = Math.floor(Date.now() / 1000) + 600;

                    const swapTx = await router.swap(paths, 0, deadline, { gasLimit: 500000 });
                    await swapTx.wait();
                    txs.push({ step: 'swap_weth_syncswap', hash: swapTx.hash });
                } catch (e) {
                    console.error('Linea SyncSwap WETH→USDC failed:', e.message);
                }
            } else {
                console.warn('Linea: SyncSwap WETH/USDC pool not found');
            }
        }

        // ── Step 2: Bridge USDC → Base via Across ──
        const usdcContract = new ethers.Contract(LINEA_USDC, ERC20_ABI_BRIDGE, signer);
        const usdcBal      = await usdcContract.balanceOf(wallet.address);

        if (usdcBal.eq(0)) {
            if (txs.length > 0) return { ok: true, txs, amount: '0 (swap done, no USDC to bridge)' };
            return { error: 'No ETH or USDC on Linea to bridge.' };
        }

        // Get Across suggested fee quote
        let quote;
        try {
            quote = await new Promise((resolve, reject) => {
                const url = `https://across.to/api/suggested-fees?inputToken=${LINEA_USDC}&outputToken=${BASE_USDC}&originChainId=59144&destinationChainId=8453&amount=${usdcBal}`;
                https.get(url, res => {
                    let d = '';
                    res.on('data', c => d += c);
                    res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
                }).on('error', reject);
            });
        } catch (e) {
            quote = {
                spokePoolAddress: LINEA_SPOKE_POOL,
                outputAmount: usdcBal.mul(99).div(100),
                quoteTimestamp: Math.floor(Date.now() / 1000),
                exclusiveRelayer: ethers.constants.AddressZero,
                exclusivityDeadline: 0,
                fillDeadline: Math.floor(Date.now() / 1000) + 7200
            };
        }

        const activeSpokePool = quote.spokePoolAddress || LINEA_SPOKE_POOL;
        const approveTx = await usdcContract.approve(activeSpokePool, usdcBal);
        await approveTx.wait();

        const spokePool = new ethers.Contract(activeSpokePool, SPOKE_POOL_ABI, signer);
        const bridgeTx  = await spokePool.depositV3(
            wallet.address, wallet.address,
            LINEA_USDC, BASE_USDC,
            usdcBal, quote.outputAmount,
            8453,
            quote.exclusiveRelayer,
            quote.timestamp || quote.quoteTimestamp,
            quote.fillDeadline,
            quote.exclusivityDeadline || 0,
            '0x',
            { gasLimit: 300000 }
        );
        await bridgeTx.wait();
        txs.push({ step: 'bridge', hash: bridgeTx.hash });

        return { ok: true, txs, amount: ethers.utils.formatUnits(usdcBal, 6) };
    } catch (e) {
        return { error: 'Linea SyncSwap bridge failed: ' + e.message };
    }
});

