// =============================================================================
// PRODUCTION LINE: ELECTRON MAIN PROCESS ENGINE (BaseRelayV3 Shell)
// Version: 5.6 | Workspace: The Factory
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
        usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
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
        routerV2: true  // signals V3 exactInputSingle ABI required
    },
    bsc: {
        name: 'BSC',
        rpc: 'https://bsc-dataseed.binance.org/',
        weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        relay: '',
        proxy: '',
        pool: '0xd99c7F6C65857AC913a8f880A4cb84032AB2FC5b',
        router: '0x10ED43C718714eb63d5aA57B78B54704E256024E'  // PancakeSwap V2 Router
    },
    linea: {
        name: 'Linea',
        rpc: 'https://rpc.linea.build',
        // FIX: corrected Linea WETH — was missing trailing 'f'
        weth: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f',
        usdc: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
        relay: '',
        proxy: '',
        pool: '',
        router: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', // SwapRouter02 on Linea (verified LineaScan)
        routerV2: true  // signals V3 exactInputSingle ABI required
    }
};

// =============================================================================
// Unified Across SpokePool addresses (verified June 2026)
// =============================================================================
const SPOKE_POOLS = {
    base:     '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64',
    polygon:  '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096',
    arbitrum: '0xe35E9842A20b3205E324596763e4Ad8060c1BC27',
    optimism: '0xa420b2d1c0841415A695b81E5B867BCD07Dff8C9',
    bsc:      '0x4e8E101924eDE233C13e2D8622DC8aED2872d505',
    linea:    '0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75'
};

const COLLECTION_ADDRESS = '0xA951A66b5800567035EEbcbBbf50A5B438761f97';
const CHAIN_IDS = { base: 8453, polygon: 137, arbitrum: 42161, optimism: 10, bsc: 56, linea: 59144 };

// ─── Across suggested-fees → depositV3 (correct flow) ───────────────────────
async function acrossDepositWithQuote(signer, fromKey, toKey, inputTokenAddr, outputTokenAddr, inputAmount, gasOverrides = {}) {
    const https = require('https');
    const srcChainId = CHAIN_IDS[fromKey];
    const dstChainId = CHAIN_IDS[toKey];
    const fallbackSpoke = SPOKE_POOLS[fromKey];
    if (!fallbackSpoke) throw new Error('No SpokePool for ' + fromKey);
    let spokePoolAddr; // will be set from API response

    // Step 1: Fetch quote from Across API
    const quote = await new Promise((resolve, reject) => {
        const url = `https://app.across.to/api/suggested-fees` +
            `?inputToken=${inputTokenAddr}` +
            `&outputToken=${outputTokenAddr}` +
            `&originChainId=${srcChainId}` +
            `&destinationChainId=${dstChainId}` +
            `&amount=${inputAmount.toString()}`;
        console.log('Across API:', url);
        https.get(url, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (j.isAmountTooLow) return reject(new Error('Amount too low for Across bridge'));
                    if (j.error) return reject(new Error('Across API error: ' + (j.error.message || j.error)));
                    resolve(j);
                } catch (e) { reject(new Error('Across API parse error: ' + d.slice(0, 200))); }
            });
        }).on('error', reject);
    });
    // Use API's spokePoolAddress (may differ from hardcoded SPOKE_POOLS)
    spokePoolAddr = quote.spokePoolAddress || fallbackSpoke;
    console.log('Across quote: spoke=', spokePoolAddr, JSON.stringify({ outputAmount: quote.outputAmount, timestamp: quote.timestamp, exclusiveRelayer: quote.exclusiveRelayer, fillDeadline: quote.fillDeadline, exclusivityDeadline: quote.exclusivityDeadline }));

    // Step 2: Approve SpokePool to spend inputToken (skip if already approved)
    const erc20 = new ethers.Contract(inputTokenAddr, ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'], signer);
    const existingAllowance = await erc20.allowance(await signer.getAddress(), spokePoolAddr);
    const feeData = await signer.provider.getFeeData();
    const gasBump = {};
    if (feeData.maxFeePerGas) {
        gasBump.maxFeePerGas = feeData.maxFeePerGas.mul(120).div(100);
        gasBump.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(120).div(100) : feeData.maxFeePerGas.div(10);
    } else if (feeData.gasPrice) {
        gasBump.gasPrice = feeData.gasPrice.mul(120).div(100);
    }
    if (existingAllowance.lt(inputAmount)) {
        console.log(fromKey, 'approving', inputAmount.toString(), '(current allowance:', existingAllowance.toString() + ')');
        const approveTx = await erc20.approve(spokePoolAddr, inputAmount, { gasLimit: 80000, ...gasOverrides, ...gasBump });
        await approveTx.wait();
    } else {
        console.log(fromKey, 'allowance OK, skipping approve');
    }

    // Step 3: depositV3 with API-sourced params
    const spokePool = new ethers.Contract(spokePoolAddr, SPOKE_POOL_ABI, signer);
    const quoteTs = Number(quote.timestamp);
    const fillDl = Number(quote.fillDeadline);
    // exclusivityDeadline: API returns absolute timestamp OR small number (= no exclusivity)
    const rawExclDl = Number(quote.exclusivityDeadline || 0);
    const exclDl = rawExclDl > 9999999 ? rawExclDl : 0;
    const exclRelayer = exclDl > 0 ? quote.exclusiveRelayer : ethers.constants.AddressZero;
    console.log('depositV3 params: quoteTs=', quoteTs, 'fillDl=', fillDl, 'exclDl=', exclDl, 'exclusiveRelayer=', exclRelayer);

    try {
        const depositGas = {};
        if (gasBump.maxFeePerGas) { depositGas.maxFeePerGas = gasBump.maxFeePerGas; depositGas.maxPriorityFeePerGas = gasBump.maxPriorityFeePerGas; }
        else if (gasBump.gasPrice) { depositGas.gasPrice = gasBump.gasPrice; }
        const tx = await spokePool.depositV3(
            await signer.getAddress(),              // depositor (signs/pays gas)
            COLLECTION_ADDRESS,                     // recipient on dest chain
            inputTokenAddr,                         // inputToken
            outputTokenAddr,                        // outputToken
            inputAmount,                            // inputAmount
            ethers.BigNumber.from(quote.outputAmount), // from API
            dstChainId,                             // destinationChainId
            exclRelayer,                            // address(0) if no exclusivity
            quoteTs,                                // from API
            fillDl,                                 // from API
            exclDl,                                 // 0 or absolute timestamp
            '0x',                                   // message
            { gasLimit: 300000, ...gasOverrides, ...depositGas }
        );
        await tx.wait();
        console.log(fromKey, '→', toKey, 'bridge SUCCESS:', tx.hash);
        return { hash: tx.hash, outputAmount: quote.outputAmount };
    } catch (depositErr) {
        console.error(fromKey, 'depositV3 FAILED:', depositErr.reason || depositErr.error?.message || depositErr.message);
        throw depositErr;
    }
}

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
let primaryPrivateKey = null;
let unlockedWallets = {};
const providers = {};
for (const key of Object.keys(NETWORKS)) {
    providers[key] = new ethers.providers.JsonRpcProvider(
        NETWORKS[key].rpc,
        { chainId: CHAIN_IDS[key], name: key, ensAddress: null }
    );
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
        // Fallback: try lowercase version for ASAR case-sensitivity
        const fullPathLower = path.join(__dirname, filePath.toLowerCase());
        const ext = path.extname(fullPath);
        try {
            const content = fs.readFileSync(fullPath);
            res.writeHead(200, { 'Content-Type': MIME[ext.toLowerCase()] || 'text/plain' });
            res.end(content);
        } catch (e) {
            try {
                const content = fs.readFileSync(fullPathLower);
                res.writeHead(200, { 'Content-Type': MIME[ext.toLowerCase()] || 'text/plain' });
                res.end(content);
            } catch (e2) {
                res.writeHead(404);
                res.end('Not found');
            }
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
            icon: path.join(__dirname, 'build', 'icon.ico'),
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
        // Migrate legacy store.contracts format if needed
        if (store.contracts) {
            const keys = Object.keys(store.contracts);
            const isLegacy = keys.some(k => ['base', 'polygon', 'arbitrum', 'optimism', 'bsc', 'linea'].includes(k));
            if (isLegacy && store.address) {
                const oldContracts = store.contracts;
                store.contracts = {};
                store.contracts[store.address.toLowerCase()] = oldContracts;
                
                try {
                    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
                    console.log('[loadStore] Migrated store.contracts to nested address format');
                } catch (e) {
                    console.error('[loadStore] Migration failed to save:', e);
                }
            }
        }
    }
    return store;
}

function setActiveWallet(address) {
    const store = loadStore();
    if (!store) return;
    
    const addrKey = address.toLowerCase();
    const contracts = (store.contracts && store.contracts[addrKey]) || {};
    
    const networks = ['base', 'polygon', 'arbitrum', 'optimism', 'bsc', 'linea'];
    for (const net of networks) {
        const list = contracts[net] || [];
        if (list.length > 0) {
            const latest = list[list.length - 1];
            NETWORKS[net].relay = latest.relay;
            NETWORKS[net].proxy = latest.proxy;
        } else {
            NETWORKS[net].relay = '';
            NETWORKS[net].proxy = '';
        }
    }
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

function initializeUnlockedSession(decryptedPrivateKey) {
    primaryPrivateKey = decryptedPrivateKey;
    wallet = new ethers.Wallet(primaryPrivateKey, provider);
    unlockedWallets = { [wallet.address.toLowerCase()]: primaryPrivateKey };
    
    // Load store and initialize store.accounts list
    const store = loadStore() || {};
    if (!store.accounts) store.accounts = [];
    
    const hasPrimary = store.accounts.some(a => a.isPrimary);
    if (!hasPrimary) {
        store.accounts.unshift({
            address: wallet.address,
            label: 'Primary Wallet',
            isPrimary: true
        });
        saveStore(store);
    }
    
    // Decrypt other sub-wallets
    const masterKey = crypto.createHash('sha256').update(primaryPrivateKey).digest();
    for (const acc of store.accounts) {
        if (acc.isPrimary) continue;
        if (acc.encryptedPrivateKey) {
            try {
                const decryptedKey = decryptGCM(masterKey, acc.encryptedPrivateKey);
                unlockedWallets[acc.address.toLowerCase()] = decryptedKey;
            } catch (e) {
                console.error(`[session] Failed to decrypt wallet ${acc.address}:`, e.message);
            }
        }
    }
    
    // Switch NETWORKS to point to active wallet's contracts
    setActiveWallet(wallet.address);
}

// Unlock with password: scrypt derive → AES-GCM decrypt pwEnvelope
ipcMain.handle('wallet:unlock', (_, password) => {
    try {
        const store = loadStore();
        if (!store) return { error: 'No wallet found' };
        const privateKey = decryptPwEnvelope(store.pwEnvelope, password);
        initializeUnlockedSession(privateKey);
        return { address: wallet.address };
    } catch (e) {
        return { error: 'Wrong password or corrupt wallet' };
    }
});

// Unlock with biometric: renderer already decrypted bioEnvelope → sends privateKey
ipcMain.handle('wallet:unlock-bio', (_, privateKey) => {
    try {
        initializeUnlockedSession(privateKey);
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

ipcMain.handle('wallet:lock', () => {
    wallet = null;
    primaryPrivateKey = null;
    unlockedWallets = {};
    return { ok: true };
});

// Set up PIN: encrypt private key with scrypt(PIN) → store in wallet.json
ipcMain.handle('wallet:setPin', (_, pin) => {
    if (!wallet) return { error: 'Wallet not unlocked — enter password first' };
    try {
        const store = loadStore();
        const salt = crypto.randomBytes(32);
        const key = crypto.scryptSync(pin, salt, 32);
        // Always encrypt the primary private key for PIN envelope
        store.pinEnvelope = { ...encryptGCM(key, primaryPrivateKey), salt: salt.toString('hex') };
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
        initializeUnlockedSession(privateKey);
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
        
        initializeUnlockedSession(privateKey);
        return { address: wallet.address };
    } catch (e) {
        return { error: 'Failed to unlock with dev key: ' + e.message };
    }
});

ipcMain.handle('wallet:getAccounts', () => {
    try {
        const store = loadStore() || {};
        return store.accounts || [];
    } catch (e) {
        return [];
    }
});

ipcMain.handle('wallet:addAccount', (_, label, importedPrivateKey) => {
    if (!primaryPrivateKey) return { error: 'Wallet not unlocked' };
    try {
        let newW;
        if (importedPrivateKey && importedPrivateKey.trim() !== '') {
            let pk = importedPrivateKey.trim();
            if (!pk.startsWith('0x')) pk = '0x' + pk;
            newW = new ethers.Wallet(pk);
        } else {
            newW = ethers.Wallet.createRandom();
        }
        
        const store = loadStore() || {};
        if (!store.accounts) store.accounts = [];
        
        // Prevent duplicate addresses
        const exists = store.accounts.some(a => a.address.toLowerCase() === newW.address.toLowerCase());
        if (exists) {
            return { error: 'Account already exists' };
        }
        
        // Encrypt with primary key
        const masterKey = crypto.createHash('sha256').update(primaryPrivateKey).digest();
        const encKey = encryptGCM(masterKey, newW.privateKey);
        
        const newAcc = {
            address: newW.address,
            label: label || `Wallet ${store.accounts.length + 1}`,
            encryptedPrivateKey: encKey
        };
        
        store.accounts.push(newAcc);
        saveStore(store);
        
        unlockedWallets[newW.address.toLowerCase()] = newW.privateKey;
        
        return store.accounts;
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('wallet:switchAccount', (_, address) => {
    if (!primaryPrivateKey) return { error: 'Wallet not unlocked' };
    try {
        const addrKey = address.toLowerCase();
        const pk = unlockedWallets[addrKey];
        if (!pk) return { error: 'Wallet key not decrypted / found in session' };
        
        wallet = new ethers.Wallet(pk, provider);
        setActiveWallet(wallet.address);
        
        return { address: wallet.address };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('wallet:deleteAccount', (_, address) => {
    if (!primaryPrivateKey) return { error: 'Wallet not unlocked' };
    try {
        const store = loadStore() || {};
        if (!store.accounts) store.accounts = [];
        
        const idx = store.accounts.findIndex(a => a.address.toLowerCase() === address.toLowerCase());
        if (idx === -1) return { error: 'Account not found' };
        if (store.accounts[idx].isPrimary) return { error: 'Cannot delete primary wallet' };
        
        store.accounts.splice(idx, 1);
        saveStore(store);
        
        delete unlockedWallets[address.toLowerCase()];
        
        // If the deleted wallet was active, fall back to primary
        if (wallet.address.toLowerCase() === address.toLowerCase()) {
            const primaryAcc = store.accounts.find(a => a.isPrimary);
            wallet = new ethers.Wallet(unlockedWallets[primaryAcc.address.toLowerCase()], provider);
            setActiveWallet(wallet.address);
        }
        
        return store.accounts;
    } catch (e) {
        return { error: e.message };
    }
});

// =============================================================================
// KEY EXPORT — Extract private key through multiple paths
// =============================================================================

// Path 1: Wallet is already unlocked in memory → return it directly
ipcMain.handle('wallet:exportKey', () => {
    if (!wallet) return { error: 'Wallet not unlocked — unlock first with password, PIN, or biometric' };
    return {
        address: wallet.address,
        privateKey: wallet.privateKey
    };
});

// Path 2: Decrypt pwEnvelope with user's password (works even if wallet is locked)
ipcMain.handle('wallet:exportKeyWithPassword', (_, password) => {
    try {
        const store = loadStore();
        if (!store) return { error: 'No wallet file found' };
        if (!store.pwEnvelope) return { error: 'No password envelope in wallet — wallet may be corrupt' };
        const privateKey = decryptPwEnvelope(store.pwEnvelope, password);
        // Verify the key produces the expected address
        const testWallet = new ethers.Wallet(privateKey);
        return {
            address: testWallet.address,
            privateKey: privateKey
        };
    } catch (e) {
        return { error: 'Decryption failed — wrong password or corrupt envelope: ' + e.message };
    }
});

// Path 3: Decrypt DPAPI-protected devKey via Windows safeStorage
// This only works on the machine that created the wallet
ipcMain.handle('wallet:exportDevKey', () => {
    try {
        const store = loadStore();
        if (!store) return { error: 'No wallet file found' };
        if (!store.devKey) return { error: 'No devKey saved — wallet was never unlocked with biometric on this machine' };
        
        let privateKey;
        if (safeStorage.isEncryptionAvailable()) {
            try {
                const buf = Buffer.from(store.devKey, 'base64');
                privateKey = safeStorage.decryptString(buf);
            } catch (e) {
                // Fallback: devKey might be stored as plaintext (dev mode)
                privateKey = store.devKey;
            }
        } else {
            privateKey = store.devKey;
        }
        
        const testWallet = new ethers.Wallet(privateKey);
        return {
            address: testWallet.address,
            privateKey: privateKey
        };
    } catch (e) {
        return { error: 'DPAPI decryption failed: ' + e.message };
    }
});

// Path 4: Decrypt PIN envelope
ipcMain.handle('wallet:exportKeyWithPin', (_, pin) => {
    try {
        const store = loadStore();
        if (!store || !store.pinEnvelope) return { error: 'No PIN envelope found' };
        const salt = Buffer.from(store.pinEnvelope.salt, 'hex');
        const key = crypto.scryptSync(pin, salt, 32);
        const privateKey = decryptGCM(key, store.pinEnvelope);
        const testWallet = new ethers.Wallet(privateKey);
        return {
            address: testWallet.address,
            privateKey: privateKey
        };
    } catch (e) {
        return { error: 'PIN decryption failed — wrong PIN: ' + e.message };
    }
});

// Path 5: Dump all available info about the wallet for backup
ipcMain.handle('wallet:exportAll', () => {
    try {
        const store = loadStore();
        if (!store) return { error: 'No wallet file found' };
        
        const result = {
            address: store.address,
            hasPassword: !!store.pwEnvelope,
            hasBiometric: !!store.bioEnvelope,
            hasPin: !!store.pinEnvelope,
            hasDevKey: !!store.devKey,
            storePath: STORE_PATH,
            privateKey: null
        };
        
        // If wallet is unlocked in memory, include the key
        if (wallet) {
            result.privateKey = wallet.privateKey;
        }
        
        // Try DPAPI devKey
        if (!result.privateKey && store.devKey && safeStorage.isEncryptionAvailable()) {
            try {
                const buf = Buffer.from(store.devKey, 'base64');
                result.privateKey = safeStorage.decryptString(buf);
            } catch (e) { /* DPAPI failed */ }
        }
        
        return result;
    } catch (e) {
        return { error: e.message };
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

ipcMain.handle('wallet:getAddressBook', () => {
    try {
        const store = loadStore();
        if (!store) return [];
        // Migration: If legacy object map exists, convert it to an array
        if (store.addressBook && !Array.isArray(store.addressBook)) {
            const arr = Object.keys(store.addressBook).map(addr => ({
                address: addr,
                label: store.addressBook[addr]
            }));
            store.addressBook = arr;
            saveStore(store);
        }
        return store.addressBook || [];
    } catch (e) {
        console.error('Error in getAddressBook:', e);
        return [];
    }
});

ipcMain.handle('wallet:saveAddress', (_, label, address) => {
    try {
        const store = loadStore() || {};
        if (!store.addressBook) store.addressBook = [];
        // Migration: convert legacy object map to array
        if (!Array.isArray(store.addressBook)) {
            store.addressBook = Object.keys(store.addressBook).map(addr => ({
                address: addr,
                label: store.addressBook[addr]
            }));
        }
        
        // Uniqueness check by label (case-insensitive)
        const idx = store.addressBook.findIndex(item => item.label.toLowerCase() === label.toLowerCase().trim());
        if (idx !== -1) {
            // Update the address for this label
            store.addressBook[idx].address = address;
        } else {
            // Add a new entry (allows multiple names/labels for the same address)
            store.addressBook.push({
                label: label.trim(),
                address: address
            });
        }
        
        saveStore(store);
        return { ok: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('wallet:deleteAddress', (_, address) => {
    try {
        const store = loadStore() || {};
        if (!store.addressBook) return { ok: true };
        if (!Array.isArray(store.addressBook)) {
            store.addressBook = Object.keys(store.addressBook).map(addr => ({
                address: addr,
                label: store.addressBook[addr]
            }));
        }
        
        // Delete all entries matching this address
        store.addressBook = store.addressBook.filter(item => item.address.toLowerCase() !== address.toLowerCase());
        saveStore(store);
        return { ok: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('wallet:getContractsList', () => {
    if (!wallet) return {};
    try {
        const store = loadStore();
        if (!store) return {};
        
        let changed = false;
        if (!store.contracts) {
            store.contracts = {};
            changed = true;
        }
        
        const addrKey = wallet.address.toLowerCase();
        if (!store.contracts[addrKey]) {
            store.contracts[addrKey] = {};
            changed = true;
        }
        
        const activeContracts = store.contracts[addrKey];
        const networks = ['base', 'polygon', 'arbitrum', 'optimism', 'bsc', 'linea'];
        for (const net of networks) {
            if (!activeContracts[net] || activeContracts[net].length === 0) {
                const relayKey = net + 'Relay';
                const proxyKey = net + 'Proxy';
                let relayAddr = '';
                let proxyAddr = '';
                if (wallet.address.toLowerCase() === store.address.toLowerCase() && store[relayKey]) {
                    relayAddr = store[relayKey];
                    proxyAddr = store[proxyKey] || '';
                } else if (NETWORKS[net] && NETWORKS[net].relay) {
                    relayAddr = NETWORKS[net].relay;
                    proxyAddr = NETWORKS[net].proxy || '';
                }
                if (relayAddr) {
                    activeContracts[net] = [{
                        relay: relayAddr,
                        proxy: proxyAddr,
                        timestamp: Date.now()
                    }];
                    changed = true;
                }
            }
        }
        
        if (changed) {
            saveStore(store);
        }
        
        return activeContracts;
    } catch (e) {
        console.error('Error in getContractsList:', e);
        return {};
    }
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
const WETH_ABI = ['function deposit() payable', 'function withdraw(uint256) external', 'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'];

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
// Uniswap V3 exactInputSingle helper
// Used by chains with routerV2 === true (Optimism, Linea) where SwapRouter02
// does NOT have swapExactTokensForTokens — only the V3 interface.
// FIX: was previously calling V2 ABI on V3 routers causing silent reverts.
// =============================================================================
// SwapRouter02 ABI — NO deadline in struct (differs from SwapRouter v1)
const UNI_V3_ROUTER_ABI = [
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
];

async function swapV3ExactInput(signer, routerAddr, tokenIn, tokenOut, amountIn, overrides = {}) {
    const router = new ethers.Contract(routerAddr, UNI_V3_ROUTER_ABI, signer);
    // SwapRouter02 struct has NO deadline field
    for (const fee of [500, 3000, 10000]) {
        try {
            const tx = await router.exactInputSingle({
                tokenIn,
                tokenOut,
                fee,
                recipient: wallet.address,
                amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            }, { gasLimit: 350000, ...overrides });
            await tx.wait();
            return { hash: tx.hash };
        } catch (e) {
            console.error(`swapV3ExactInput fee=${fee} FAIL:`, e.reason || e.message);
        }
    }
    return null;
}

// =============================================================================
// RELAY V3: Route WETH→USDC swap through Relay or Router
// FIX: routerV2 chains (Optimism, Linea) now use exactInputSingle instead of
//      swapExactTokensForTokens which does not exist on SwapRouter02.
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
        
        if (net.relay && net.relay !== '') {
            // Custom relay contract path (Base)
            let minOut;
            try {
                const routerContract = new ethers.Contract(net.router, [
                    'function getAmountsOut(uint256 amountIn, address[] path) external view returns (uint256[] memory)'
                ], signer);
                const amounts = await routerContract.getAmountsOut(amountWei, [net.weth, net.usdc]);
                minOut = amounts[amounts.length - 1].mul(98).div(100);
            } catch (err) {
                minOut = amountWei.mul(1500).div(ethers.BigNumber.from("1000000000000"));
            }
            const approveTx = await weth.approve(net.relay, amountWei);
            await approveTx.wait();
            const relay = new ethers.Contract(net.relay, RELAY_V3_ABI, signer);
            const swapTx = await relay.swap(
                net.weth, net.usdc, amountWei, minOut, [net.pool], deadline,
                { gasLimit: 500000 }
            );
            await swapTx.wait();
            return { hash: swapTx.hash, amount: amountEth, network: net.name };
        } else if (net.routerV2) {
            // FIX: SwapRouter02 chains (Optimism, Linea) — must use V3 exactInputSingle
            const approveTx = await weth.approve(net.router, amountWei);
            await approveTx.wait();
            const result = await swapV3ExactInput(signer, net.router, net.weth, net.usdc, amountWei);
            if (!result) return { error: 'WETH→USDC swap failed on ' + net.name + ' — no liquid pool found at any fee tier' };
            return { hash: result.hash, amount: amountEth, network: net.name };
        } else {
            // V2-style router fallback (Polygon, Arbitrum, BSC)
            let minOut;
            try {
                const routerContract = new ethers.Contract(net.router, [
                    'function getAmountsOut(uint256 amountIn, address[] path) external view returns (uint256[] memory)'
                ], signer);
                const amounts = await routerContract.getAmountsOut(amountWei, [net.weth, net.usdc]);
                minOut = amounts[amounts.length - 1].mul(98).div(100);
            } catch (err) {
                if (networkKey === 'bsc') {
                    minOut = amountWei.mul(300);
                } else {
                    minOut = amountWei.mul(1500).div(ethers.BigNumber.from("1000000000000"));
                }
            }
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
// SWEEP TO USDC — Defensive rewrite. Key principles:
//   1. Check gas BEFORE wrapping (don't burn gas on wrap if swap will fail)
//   2. Swap existing WETH even if we can't wrap more
//   3. Gas-starved chains bridge WETH directly to Base via Across
//   4. All calls have explicit gasLimit (no estimateGas ENS issues)
// =============================================================================

// Minimum ETH needed for gas on each chain (wrap + approve + swap ≈ 3 txns)
const MIN_GAS = {
    base: ethers.utils.parseEther('0.0003'),      // ~$0.75
    polygon: ethers.utils.parseEther('0.05'),      // POL, ~$0.01
    arbitrum: ethers.utils.parseEther('0.0003'),   // ~$0.75
    optimism: ethers.utils.parseEther('0.0008'),   // ~$2 (L1 data fees)
    bsc: ethers.utils.parseUnits('0.00005', 18),     // BNB, ~$0.03 (BSC gas is ~1-3 gwei)
    linea: ethers.utils.parseEther('0.0008')       // ~$2
};

ipcMain.handle('relay:sweepToUsdc', async (_, networkKey = 'base') => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    let step = 'init';
    try {
        const net = NETWORKS[networkKey];
        const prov = providers[networkKey];
        const signer = wallet.connect(prov);

        // ── Step 0: Read balances ───────────────────────────────────────────
        step = 'balances';
        let ethBal = await prov.getBalance(wallet.address);
        const wethC = new ethers.Contract(net.weth, WETH_ABI, signer);
        let wethBal = await wethC.balanceOf(wallet.address);
        const minGas = MIN_GAS[networkKey] || ethers.utils.parseEther('0.001');

        // ── Polygon special path (Uniswap V3 + POL native) ──────────────────
        if (networkKey === 'polygon') {
            const overrides = await getPolygonGasOverrides(prov);
            let swapCount = 0, lastHash = '', sweptWeth = '0', sweptPol = '0';
            const wpolAddr = '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270';

            // 1. Swap WETH (Wrapped Ether on Polygon) to USDC
            if (wethBal.gt(0)) {
                step = 'poly.swap.weth';
                const wethContract = new ethers.Contract(net.weth, WETH_ABI, signer);
                const appTx = await wethContract.approve(net.router, wethBal, { gasLimit: 100000, ...overrides });
                await appTx.wait();
                
                const result = await swapV3ExactInput(signer, net.router, net.weth, net.usdc, wethBal, overrides);
                if (result) {
                    lastHash = result.hash;
                    sweptWeth = ethers.utils.formatEther(wethBal);
                    swapCount++;
                }
            }

            // 2. Swap POL (native) to USDC
            const gasBuffer = ethers.utils.parseEther("2.0");
            if (ethBal.gt(gasBuffer)) {
                const swapAmount = ethBal.sub(gasBuffer);
                step = 'poly.swap.pol';
                
                // Wrap POL to WPOL first
                const wpolC = new ethers.Contract(wpolAddr, WETH_ABI, signer);
                const depTx = await wpolC.deposit({ value: swapAmount, gasLimit: 80000, ...overrides });
                await depTx.wait();
                
                // Approve WPOL to router
                const appTx = await wpolC.approve(net.router, swapAmount, { gasLimit: 100000, ...overrides });
                await appTx.wait();
                
                // Swap WPOL to USDC
                const result = await swapV3ExactInput(signer, net.router, wpolAddr, net.usdc, swapAmount, overrides);
                if (result) {
                    lastHash = result.hash;
                    sweptPol = ethers.utils.formatEther(swapAmount);
                    swapCount++;
                }
            }

            if (swapCount > 0) {
                let msg = '';
                if (sweptWeth !== '0') msg += sweptWeth + ' WETH';
                if (sweptPol !== '0') { if (msg) msg += ' + '; msg += sweptPol + ' POL'; }
                return { status: 'success', hash: lastHash, amount: msg, network: net.name };
            }
            return { status: 'skipped', reason: 'No WETH or extra POL (above 2.0 POL gas buffer) on Polygon' };
        }

        // ── Gas-starved chains: try unwrap for gas first ──
        if (ethBal.lt(minGas) && wethBal.gt(0) && networkKey !== 'base') {
            const unwrapGasNeeded = minGas.mul(4); // enough for unwrap + approve + swap + buffer
            const unwrapAmt = unwrapGasNeeded.sub(ethBal);
            const toUnwrap = unwrapAmt.gt(wethBal) ? wethBal : unwrapAmt;
            
            try {
                step = 'unwrap.rescue';
                console.log(networkKey, 'rescuing gas: unwrapping', ethers.utils.formatEther(toUnwrap), 'WETH for gas');
                const unwrapTx = await wethC.withdraw(toUnwrap, { gasLimit: 60000 });
                await unwrapTx.wait();
                ethBal = await prov.getBalance(wallet.address);
                wethBal = await wethC.balanceOf(wallet.address);
            } catch (unwrapErr) {
                console.log(networkKey, 'unwrap rescue failed:', unwrapErr.reason || unwrapErr.message);
                const symbol = networkKey === 'bsc' ? 'BNB' : 'ETH';
                return { status: 'gas_needed', reason: 'Not enough gas on ' + net.name + ' (' + parseFloat(ethers.utils.formatEther(ethBal)).toFixed(6) + ' ' + symbol + '). Send ~0.002 ' + symbol + ' to continue.' };
            }
        }

        // ── No gas, no WETH → nothing to do ─────────────────────────────────
        if (ethBal.lt(minGas) && wethBal.eq(0)) {
            return { status: 'skipped', reason: 'No ETH or WETH to sweep on ' + net.name };
        }

        // ── Wrap/Unwrap top-ups ─────────────────────────────────────────────
        const gasNeeded = minGas.mul(3);
        let bscGas = {};
        if (networkKey === 'bsc') {
            const gp = await prov.getGasPrice();
            bscGas = { gasPrice: gp };
        }
        if (wethBal.gt(0) && ethBal.lt(gasNeeded)) {
            const unwrapAmount = gasNeeded.sub(ethBal);
            const toUnwrap = unwrapAmount.gt(wethBal) ? wethBal : unwrapAmount;
            step = 'unwrap.gas';
            const unwrapTx = await wethC.withdraw(toUnwrap, { gasLimit: 60000, ...bscGas });
            await unwrapTx.wait();
        } else if (wethBal.eq(0) && ethBal.gt(gasNeeded.mul(2))) {
            const wrapAmount = ethBal.sub(gasNeeded);
            step = 'wrap';
            const wrapTx = await wethC.deposit({ value: wrapAmount, gasLimit: 60000 });
            await wrapTx.wait();
        }

        step = 'check.weth';
        let finalWeth = await wethC.balanceOf(wallet.address);

        if (finalWeth.eq(0)) {
            return { status: 'skipped', reason: 'No WETH to swap on ' + net.name + ' (ETH too low to wrap safely)' };
        }

        // ── SWAP: Route through the correct DEX ─────────────────────────────
        if (networkKey === 'base') {
            const BASE_SWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
            step = 'base.approve';
            const approveTx = await wethC.approve(BASE_SWAP_ROUTER, finalWeth, { gasLimit: 60000 });
            await approveTx.wait();

            step = 'base.swap';
            const swapIface = new ethers.utils.Interface([
                'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256)'
            ]);
            const calldata = swapIface.encodeFunctionData('exactInputSingle', [{
                tokenIn: net.weth,
                tokenOut: net.usdc,
                fee: 500,
                recipient: wallet.address,
                amountIn: finalWeth,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            }]);

            const simResult = await prov.call({ from: wallet.address, to: BASE_SWAP_ROUTER, data: calldata });
            const usdcOut = ethers.utils.defaultAbiCoder.decode(['uint256'], simResult)[0];
            console.log('Base swap simulation OK. Expected USDC:', ethers.utils.formatUnits(usdcOut, 6));

            const tx = await signer.sendTransaction({
                to: BASE_SWAP_ROUTER,
                data: calldata,
                gasLimit: 350000
            });
            const receipt = await tx.wait();
            if (receipt.status === 0) return { error: '[base.swap] Transaction reverted on-chain' };
            return { status: 'success', hash: tx.hash, amount: ethers.utils.formatEther(finalWeth) + ' ETH', network: net.name };

        } else if (networkKey === 'bsc') {
            step = 'bsc.swap';
            const routerContract = new ethers.Contract(net.router, [
                'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])'
            ], signer);
            
            console.log('bsc sweep: swapping', ethers.utils.formatEther(finalWeth), 'WBNB to USDC');
            const approveTx = await wethC.approve(net.router, finalWeth, { gasLimit: 60000, ...bscGas });
            await approveTx.wait();
            
            const deadline = Math.floor(Date.now() / 1000) + 600;
            const swapTx = await routerContract.swapExactTokensForTokens(
                finalWeth, 0, [net.weth, net.usdc], wallet.address, deadline,
                { gasLimit: 250000, ...bscGas }
            );
            await swapTx.wait();
            console.log('bsc sweep: swap complete, tx =', swapTx.hash);
            return { status: 'success', hash: swapTx.hash, amount: ethers.utils.formatEther(finalWeth) + ' BNB', network: net.name };

        } else {
            // Swap Router02 chains (Optimism, Linea, Arbitrum) using Uniswap V3 SwapRouter02
            step = 'l2.swap.approve';
            const approveTx = await wethC.approve(net.router, finalWeth, { gasLimit: 100000, ...bscGas });
            await approveTx.wait();

            step = 'l2.swap.execute';
            const result = await swapV3ExactInput(signer, net.router, net.weth, net.usdc, finalWeth, bscGas);
            if (!result) {
                return { error: 'WETH→USDC swap failed on ' + net.name + ' — no liquid pool found' };
            }
            return { status: 'success', hash: result.hash, amount: ethers.utils.formatEther(finalWeth) + ' ETH', network: net.name };
        }
    } catch (e) {
        let msg = e.reason || e.message || 'Sweep failed';
        if (e.error && e.error.message) msg = e.error.message;
        return { error: '[' + (step||'?') + '] ' + msg };
    }
});


// =============================================================================
// ERC-20 ABI for bridge approvals
// =============================================================================
const ERC20_ABI_BRIDGE = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)'
];

// =============================================================================
// Across SpokePool ABI
// =============================================================================
const SPOKE_POOL_ABI = [
    'function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes calldata message) payable'
];

// =============================================================================
// CUSTOM BRIDGE — Bridges specific amounts of USDC/WETH between networks
// FIX: unified SPOKE_POOLS map — was duplicated with inconsistent/stale addresses
// FIX: ETH path fee tier loop corrected to [500, 3000, 10000] — removed invalid 100 tier
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
            const wethContract = new ethers.Contract(srcNet.weth, WETH_ABI, signer);
            const wrapTx = await wethContract.deposit({ value: amountUnits, gasLimit: 60000, ...overrides });
            await wrapTx.wait();

            // Step 2: Approve + swap WETH → USDC via correct router interface
            // FIX: use V3 exactInputSingle for routerV2 chains; V3 path for others
            const srcUsdc = fromKey === 'polygon' ? '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' : srcNet.usdc;
            const approveTx = await wethContract.approve(srcNet.router, amountUnits, { gasLimit: 60000, ...overrides });
            await approveTx.wait();

            let usdcReceived;
            // FIX: fee tier 100 removed — only valid on Ethereum mainnet, not Optimism/Linea
            const feeTiers = [500, 3000, 10000];
            if (srcNet.routerV2) {
                // V3 router (SwapRouter02) — use exactInputSingle
                const result = await swapV3ExactInput(signer, srcNet.router, srcNet.weth, srcUsdc, amountUnits, overrides);
                if (result) {
                    const usdcContract = new ethers.Contract(srcUsdc, ['function balanceOf(address) view returns (uint256)'], signer);
                    usdcReceived = await usdcContract.balanceOf(wallet.address);
                }
            } else {
                // Legacy V3 router (single endpoint, no multicall) — try fee tiers
                const uniV3RouterABI = ['function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256)'];
                const uniV3Router = new ethers.Contract(srcNet.router, uniV3RouterABI, signer);
                const deadline = Math.floor(Date.now() / 1000) + 600;
                for (const fee of feeTiers) {
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
            }

            if (!usdcReceived || usdcReceived.eq(0)) {
                return { error: 'WETH → USDC swap failed on ' + srcNet.name + '. Try bridging USDC directly.' };
            }

            // Step 3: Bridge USDC → destination via Across
            const dstUsdc = toKey === 'polygon' ? '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' : dstNet.usdc;
            const result = await acrossDepositWithQuote(signer, fromKey, toKey, srcUsdc, dstUsdc, usdcReceived, overrides);
            const usdcOut = parseFloat(ethers.utils.formatUnits(usdcReceived, 6)).toFixed(2);
            return { hash: result.hash, amount: usdcOut, token: 'USDC' };
        }

        // ── USDC / WETH paths ──
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
        
        // Use centralized Across helper with proper API params
        const result = await acrossDepositWithQuote(signer, fromKey, toKey, inputToken, outputToken, amountUnits, overrides);
        return { hash: result.hash, amount: amountStr, token: tokenKey.toUpperCase() };
    } catch (e) {
        let msg = e.reason || e.message || 'Bridge failed';
        if (e.error && e.error.message) msg = e.error.message;
        return { error: msg };
    }
});


// =============================================================================
// CONTRACT COMMAND CENTER ADMIN & DEPLOYMENT HANDLERS
// =============================================================================
const DEPLOY_PARAMS = {
    polygon: {
        weth: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', // WMATIC/WPOL
        factory: '0x5757371414417b1542a454cb1a38df10f502b396' // QuickSwap Factory
    },
    bsc: {
        weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
        factory: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73' // PancakeSwap Factory
    },
    arbitrum: {
        weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
        factory: '0xc35dad65031f236065a041d28d81353c12218e4e' // SushiSwap Factory
    },
    optimism: {
        weth: '0x4200000000000000000000000000000000000006', // WETH
        factory: '0xc35dad65031f236065a041d28d81353c12218e4e' // SushiSwap Factory fallback
    },
    linea: {
        weth: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', // WETH
        factory: '0x01b084e5ad6c24fcb2d285aee3a9ccb4a3af825a' // LineaSwap Factory
    },
    base: {
        weth: '0x4200000000000000000000000000000000000006', // WETH
        factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6' // Uniswap V2 Factory Base
    }
};

const BASERELAY_ABI_ADMIN = [
    'function owner() view returns (address)',
    'function TREASURY() view returns (address)',
    'function updateTreasury(address newTreasury) external',
    'function withdrawETH() external',
    'function withdrawToken(address token) external',
    'function transferOwnership(address newOwner) external',
    'function getContractBalance() view returns (uint256)'
];

async function handleDeployNetwork(networkKey) {
    if (!wallet) return { error: 'Wallet not unlocked' };
    try {
        const net = NETWORKS[networkKey];
        const prov = providers[networkKey];
        const signer = wallet.connect(prov);
        
        const params = DEPLOY_PARAMS[networkKey];
        if (!params) return { error: 'Unsupported network for automated deployment' };
        
        let artifactsDir = path.join(__dirname, 'artifacts');
        if (!fs.existsSync(artifactsDir)) {
            artifactsDir = path.join(__dirname, 'hardhat-env', 'artifacts');
        }
        
        const relayArtifactPath = path.join(artifactsDir, 'contracts', 'BaseRelayV4.sol', 'BaseRelayV4.json');
        const relayArtifact = JSON.parse(fs.readFileSync(relayArtifactPath, 'utf8'));
        
        const proxyArtifactPath = path.join(artifactsDir, 'contracts', 'BotCompatibilityProxy.sol', 'BotCompatibilityProxy.json');
        const proxyArtifact = JSON.parse(fs.readFileSync(proxyArtifactPath, 'utf8'));
        
        // Dynamic gas overrides for Polygon
        const overrides = networkKey === 'polygon' ? await getPolygonGasOverrides(prov) : {};
        // Fetch legacy gas price for BSC
        if (networkKey === 'bsc') {
            const gp = await prov.getGasPrice();
            overrides.gasPrice = gp;
        }

        console.log(`[IPC deployNetwork] Deploying BaseRelayV4 to ${net.name}...`);
        const relayFactory = new ethers.ContractFactory(relayArtifact.abi, relayArtifact.bytecode, signer);
        const relayContract = await relayFactory.deploy(COLLECTION_ADDRESS, { ...overrides });
        await relayContract.deployed();
        const relayAddress = relayContract.address;
        console.log(`[IPC deployNetwork] BaseRelayV4 deployed to ${relayAddress} on ${net.name}`);

        console.log(`[IPC deployNetwork] Deploying BotCompatibilityProxy to ${net.name}...`);
        const proxyFactory = new ethers.ContractFactory(proxyArtifact.abi, proxyArtifact.bytecode, signer);
        const proxyContract = await proxyFactory.deploy(relayAddress, params.weth, params.factory, { ...overrides });
        await proxyContract.deployed();
        const proxyAddress = proxyContract.address;
        console.log(`[IPC deployNetwork] BotCompatibilityProxy deployed to ${proxyAddress} on ${net.name}`);

        // Save to store
        const store = loadStore() || {};
        if (!store.contracts) store.contracts = {};
        const addrKey = wallet.address.toLowerCase();
        if (!store.contracts[addrKey]) store.contracts[addrKey] = {};
        if (!store.contracts[addrKey][networkKey]) store.contracts[addrKey][networkKey] = [];
        
        store.contracts[addrKey][networkKey].push({
            relay: relayAddress,
            proxy: proxyAddress,
            timestamp: Date.now()
        });
        
        // Update flat keys for legacy compatibility on primary account only
        if (wallet.address.toLowerCase() === store.address.toLowerCase()) {
            store[networkKey + 'Relay'] = relayAddress;
            store[networkKey + 'Proxy'] = proxyAddress;
        }
        
        NETWORKS[networkKey].relay = relayAddress;
        NETWORKS[networkKey].proxy = proxyAddress;
        
        saveStore(store);

        return { relay: relayAddress, proxy: proxyAddress };
    } catch (e) {
        console.error(`Failed deploying on ${networkKey}:`, e);
        return { error: e.reason || e.message || 'Deployment execution failed' };
    }
}

ipcMain.handle('wallet:deployNetwork', async (_, networkKey) => {
    return handleDeployNetwork(networkKey);
});

ipcMain.handle('wallet:deployPolygon', async () => {
    return handleDeployNetwork('polygon');
});

ipcMain.handle('wallet:getContractState', async (_, networkKey, contractAddress) => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    try {
        const prov = providers[networkKey];
        const contract = new ethers.Contract(contractAddress, BASERELAY_ABI_ADMIN, prov);
        const owner = await contract.owner();
        const treasury = await contract.TREASURY();
        
        const nativeBalance = await prov.getBalance(contractAddress);
        const net = NETWORKS[networkKey];
        let usdcBalance = '0';
        if (net && net.usdc) {
            const decimals = networkKey === 'bsc' ? 18 : 6;
            const usdcContract = new ethers.Contract(net.usdc, ['function balanceOf(address) view returns (uint256)'], prov);
            const bal = await usdcContract.balanceOf(contractAddress);
            usdcBalance = ethers.utils.formatUnits(bal, decimals);
        }
        
        return {
            owner,
            treasury,
            nativeBalance: ethers.utils.formatEther(nativeBalance),
            usdcBalance
        };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('wallet:updateTreasury', async (_, networkKey, contractAddress, newTreasury) => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    try {
        const prov = providers[networkKey];
        const signer = wallet.connect(prov);
        const contract = new ethers.Contract(contractAddress, BASERELAY_ABI_ADMIN, signer);
        
        const overrides = networkKey === 'polygon' ? await getPolygonGasOverrides(prov) : {};
        if (networkKey === 'bsc') {
            const gp = await prov.getGasPrice();
            overrides.gasPrice = gp;
        }
        
        const tx = await contract.updateTreasury(newTreasury, { gasLimit: 80000, ...overrides });
        await tx.wait();
        return { hash: tx.hash };
    } catch (e) {
        return { error: e.reason || e.message };
    }
});

ipcMain.handle('wallet:transferOwnership', async (_, networkKey, contractAddress, newOwner) => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    try {
        const prov = providers[networkKey];
        const signer = wallet.connect(prov);
        const contract = new ethers.Contract(contractAddress, BASERELAY_ABI_ADMIN, signer);
        
        const overrides = networkKey === 'polygon' ? await getPolygonGasOverrides(prov) : {};
        if (networkKey === 'bsc') {
            const gp = await prov.getGasPrice();
            overrides.gasPrice = gp;
        }
        
        const tx = await contract.transferOwnership(newOwner, { gasLimit: 80000, ...overrides });
        await tx.wait();
        return { hash: tx.hash };
    } catch (e) {
        return { error: e.reason || e.message };
    }
});

ipcMain.handle('wallet:withdrawETH', async (_, networkKey, contractAddress) => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    try {
        const prov = providers[networkKey];
        const signer = wallet.connect(prov);
        const contract = new ethers.Contract(contractAddress, BASERELAY_ABI_ADMIN, signer);
        
        const overrides = networkKey === 'polygon' ? await getPolygonGasOverrides(prov) : {};
        if (networkKey === 'bsc') {
            const gp = await prov.getGasPrice();
            overrides.gasPrice = gp;
        }
        
        const tx = await contract.withdrawETH({ gasLimit: 80000, ...overrides });
        await tx.wait();
        return { hash: tx.hash };
    } catch (e) {
        return { error: e.reason || e.message };
    }
});

ipcMain.handle('wallet:withdrawToken', async (_, networkKey, contractAddress, tokenAddress) => {
    if (!wallet) return { error: 'Wallet not unlocked' };
    try {
        const prov = providers[networkKey];
        const signer = wallet.connect(prov);
        const contract = new ethers.Contract(contractAddress, BASERELAY_ABI_ADMIN, signer);
        
        const overrides = networkKey === 'polygon' ? await getPolygonGasOverrides(prov) : {};
        if (networkKey === 'bsc') {
            const gp = await prov.getGasPrice();
            overrides.gasPrice = gp;
        }
        
        const tx = await contract.withdrawToken(tokenAddress, { gasLimit: 80000, ...overrides });
        await tx.wait();
        return { hash: tx.hash };
    } catch (e) {
        return { error: e.reason || e.message };
    }
});



