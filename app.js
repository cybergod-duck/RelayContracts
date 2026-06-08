// Cold Storage Wallet — Base Network
// Tabs: Wallet (balance/QR/send/history) + Relay (ETH→WETH wrap)
// Password + PIN dual-envelope unlock
// v3: Toast notifications, MAX buttons, private key export

const lockedEl = document.getElementById('locked');
const unlockedEl = document.getElementById('unlocked');
const newWalletEl = document.getElementById('newWallet');
const existingWalletEl = document.getElementById('existingWallet');
const errorEl = document.getElementById('error');
const tabWallet = document.getElementById('tabWallet');
const tabRelay = document.getElementById('tabRelay');

let balanceInterval = null;
let priceInterval = null;
let liveFeedInterval = null;
let ethPrice = 3100.00;
let polPrice = 0.45;
let bnbPrice = 580.00;
let currentTab = 'wallet';
let ethBalance = 0; // cached for MAX buttons

// =============================================================================
// TOAST SYSTEM — replaces bare error divs
// =============================================================================
function toast(msg, type) {
    type = type || 'error';
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const icons = { error: '⚠️', success: '✅', info: 'ℹ️' };
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.innerHTML = '<span>' + (icons[type] || '') + '</span> ' + msg;
    container.appendChild(el);
    setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
    }, 4000);
}

function showError(msg) {
    errorEl.textContent = msg;
    if (msg) toast(msg, 'error');
    setTimeout(function () { errorEl.textContent = ''; }, 6000);
}

// =============================================================================
// TABS
// =============================================================================
function switchTab(tab) {
    if (tab === 'wallet') {
        tab = 'networks';
    }
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => {
        if (tab === 'networks' && t.textContent.includes('Networks')) t.classList.add('active');
        if (tab === 'relay' && t.textContent.includes('Relay')) t.classList.add('active');
    });
    
    const tabNet = document.getElementById('tabNetworks');
    if (tabNet) tabNet.classList.toggle('hidden', tab !== 'networks');
    document.getElementById('tabRelay').classList.toggle('hidden', tab !== 'relay');
    
    if (tab === 'relay') {
        refreshRelay();
        startLiveFeed();
    } else {
        stopLiveFeed();
    }
}

// =============================================================================
// CREATE WALLET
// =============================================================================
async function createWallet() {
    const pw = document.getElementById('createPw').value;
    const pw2 = document.getElementById('createPw2').value;
    if (!pw || pw.length < 8) return showError('Password must be at least 8 characters');
    if (pw !== pw2) return showError('Passwords do not match');
    try {
        const result = await window.wallet.create(pw);
        if (result.error) return showError(result.error);
        showUnlocked(result.address);
        // Bio enrollment happens via "Set up Face Unlock" button after unlock
    } catch (e) {
        showError('Wallet creation failed: ' + e.message);
    }
}

// =============================================================================
// PIN SETUP (modal-based, no prompt())
// =============================================================================
function setupPin() {
    document.getElementById('pinModal').classList.remove('hidden');
    document.getElementById('pinInput').value = '';
    document.getElementById('pinConfirm').value = '';
    document.getElementById('pinError').textContent = '';
    document.getElementById('pinInput').focus();
}

function closePinModal() {
    document.getElementById('pinModal').classList.add('hidden');
}

function togglePassword() {
    const el = document.getElementById('pwFields');
    el.classList.toggle('hidden');
    if (!el.classList.contains('hidden')) document.getElementById('unlockPw').focus();
}

async function confirmPin() {
    const pin = document.getElementById('pinInput').value;
    const confirm = document.getElementById('pinConfirm').value;
    const errEl = document.getElementById('pinError');
    if (!pin || pin.length < 4 || pin.length > 8 || !/^\d+$/.test(pin)) {
        errEl.textContent = 'PIN must be 4-8 digits'; return;
    }
    if (pin !== confirm) {
        errEl.textContent = 'PINs do not match'; return;
    }
    try {
        const result = await window.wallet.setPin(pin);
        if (result.error) { errEl.textContent = result.error; return; }
        closePinModal();
        document.getElementById('pinSetupBtn').textContent = '✅ PIN Ready';
    } catch (e) {
        errEl.textContent = 'Failed: ' + e.message;
    }
}

// =============================================================================
// PIN UNLOCK
// =============================================================================
async function pinUnlock() {
    const pin = document.getElementById('unlockPin').value;
    if (!pin) return showError('Enter your PIN');
    try {
        const result = await window.wallet.unlockWithPin(pin);
        if (result.error) return showError(result.error);
        showUnlocked(result.address);
    } catch (e) {
        showError('PIN unlock failed');
    }
}

// =============================================================================
// PASSWORD UNLOCK
// =============================================================================
async function passwordUnlock() {
    const pw = document.getElementById('unlockPw').value;
    if (!pw) return showError('Enter your password');
    try {
        const result = await window.wallet.unlock(pw);
        if (result.error) return showError(result.error);
        showUnlocked(result.address);
    } catch (e) {
        showError('Password unlock failed: ' + e.message);
    }
}

// =============================================================================
// SHOW UNLOCKED
// =============================================================================
async function showUnlocked(address) {
    lockedEl.classList.add('hidden');
    unlockedEl.classList.remove('hidden');
    window.wallet.resizeWindow(880, 730);
    document.getElementById('addr').textContent = address;
    document.getElementById('sendTo').value = '';
    document.getElementById('sendAmount').value = '';
    document.getElementById('sendResult').innerHTML = '';
    document.getElementById('sweepResult').innerHTML = '';

    // QR
    await updateQrCode();

    // Default to networks tab on the right content panel
    switchTab('networks');

    await loadAddressBook(); // Populate address book dropdown
    await fetchPrice();
    await refreshBalance();
    await refreshTxHistory();
    autoSelectHighestAsset();
    if (balanceInterval) clearInterval(balanceInterval);
    balanceInterval = setInterval(() => { refreshBalance(); }, 30000);
    if (priceInterval) clearInterval(priceInterval);
    priceInterval = setInterval(fetchPrice, 60000);

    // Auto-open deployer modal if any network has a pending deployment
    setTimeout(async () => {
        const checkFuncs = [
            window.wallet.polygonAddresses,
            window.wallet.arbitrumAddresses,
            window.wallet.optimismAddresses,
            window.wallet.bscAddresses,
            window.wallet.lineaAddresses
        ];
        let pending = false;
        for (const func of checkFuncs) {
            try {
                const addrs = await func();
                if (!addrs.relay || addrs.relay === '') {
                    pending = true;
                    break;
                }
            } catch (e) {}
        }
        if (pending) {
            openDeployerModal();
        }
    }, 1200);
}

async function fetchPrice() {
    try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,polygon-ecosystem-token,binancecoin&vs_currencies=usd');
        const data = await res.json();
        if (data.ethereum && data.ethereum.usd) {
            ethPrice = data.ethereum.usd;
        }
        if (data['polygon-ecosystem-token'] && data['polygon-ecosystem-token'].usd) {
            polPrice = data['polygon-ecosystem-token'].usd;
        }
        if (data.binancecoin && data.binancecoin.usd) {
            bnbPrice = data.binancecoin.usd;
        }
        await refreshBalance();
    } catch (e) { /* Coingecko rate-limited or offline — keep last known price */ }
}

async function refreshBalance() {
    try {
        const balances = await window.wallet.balance();
        if (balances.error) {
            document.getElementById('totalUsd').textContent = '--';
            document.getElementById('totalUsd').classList.add('loading');
            document.getElementById('ethLine').innerHTML = '-- ETH';
            document.getElementById('polLine').innerHTML = '-- POL';
            const bnbLine = document.getElementById('bnbLine');
            if (bnbLine) bnbLine.innerHTML = '-- BNB';
            document.getElementById('wethLine').textContent = '-- WETH';
            document.getElementById('usdcLine').textContent = '-- USDC';
            ethBalance = 0;
            return;
        }

        let baseEth = parseFloat(balances.base?.eth || '0') || 0;
        let polyPol = parseFloat(balances.polygon?.eth || '0') || 0;
        let arbEth = parseFloat(balances.arbitrum?.eth || '0') || 0;
        let opEth = parseFloat(balances.optimism?.eth || '0') || 0;
        let bscBnb = parseFloat(balances.bsc?.eth || '0') || 0;
        let lineaEth = parseFloat(balances.linea?.eth || '0') || 0;
        
        let wethBals = {};
        try { wethBals = await window.wallet.relayWethBalance(); } catch (e) {}
        let baseWeth = parseFloat(wethBals.base || '0') || 0;
        let polyWeth = parseFloat(wethBals.polygon || '0') || 0;
        let arbWeth = parseFloat(wethBals.arbitrum || '0') || 0;
        let opWeth = parseFloat(wethBals.optimism || '0') || 0;
        let bscWeth = parseFloat(wethBals.bsc || '0') || 0;
        let lineaWeth = parseFloat(wethBals.linea || '0') || 0;

        let usdcBals = {};
        try { usdcBals = await window.wallet.usdcBalance(); } catch (e) {}
        let baseUsdc = parseFloat(usdcBals.base || '0') || 0;
        let polyUsdc = parseFloat(usdcBals.polygon || '0') || 0;
        let arbUsdc = parseFloat(usdcBals.arbitrum || '0') || 0;
        let opUsdc = parseFloat(usdcBals.optimism || '0') || 0;
        let bscUsdc = parseFloat(usdcBals.bsc || '0') || 0;
        let lineaUsdc = parseFloat(usdcBals.linea || '0') || 0;

        const totalEth = baseEth + arbEth + opEth + lineaEth;
        const totalPol = polyPol;
        const totalBnb = bscBnb;
        const totalWeth = baseWeth + polyWeth + arbWeth + opWeth + bscWeth + lineaWeth;
        const totalUsdc = baseUsdc + polyUsdc + arbUsdc + opUsdc + bscUsdc + lineaUsdc;

        ethBalance = baseEth; // fallback
        window.balances = {
            base: { eth: baseEth, weth: baseWeth, usdc: baseUsdc },
            polygon: { eth: polyPol, weth: polyWeth, usdc: polyUsdc },
            arbitrum: { eth: arbEth, weth: arbWeth, usdc: arbUsdc },
            optimism: { eth: opEth, weth: opWeth, usdc: opUsdc },
            bsc: { eth: bscBnb, weth: bscWeth, usdc: bscUsdc },
            linea: { eth: lineaEth, weth: lineaWeth, usdc: lineaUsdc }
        };

        // Render aggregated totals on Wallet tab
        document.getElementById('totalUsd').classList.remove('loading');
        const currentEthPrice = ethPrice || 1557.86;
        const currentPolPrice = polPrice || 0.0733;
        const currentBnbPrice = bnbPrice || 580.00;
        
        const totalUsd = (totalEth + (totalWeth - bscWeth)) * currentEthPrice + totalUsdc + (totalPol * currentPolPrice) + (totalBnb + bscWeth) * currentBnbPrice;
        document.getElementById('totalUsd').textContent = '$' + totalUsd.toFixed(2);
        
        document.getElementById('ethLine').innerHTML = totalEth.toFixed(6) + ' ETH <span class="dim"> - $' + (totalEth * currentEthPrice).toFixed(2) + '</span>';
        document.getElementById('polLine').innerHTML = totalPol.toFixed(6) + ' POL <span class="dim"> - $' + (totalPol * currentPolPrice).toFixed(2) + '</span>';
        
        const bnbLine = document.getElementById('bnbLine');
        if (bnbLine) {
            const bnbTotal = (totalBnb + bscWeth) * currentBnbPrice;
            if (bscWeth > 0) {
                bnbLine.innerHTML = totalBnb.toFixed(6) + ' BNB + ' + bscWeth.toFixed(6) + ' WBNB <span class="dim"> - $' + bnbTotal.toFixed(2) + '</span>';
            } else {
                bnbLine.innerHTML = totalBnb.toFixed(6) + ' BNB <span class="dim"> - $' + (totalBnb * currentBnbPrice).toFixed(2) + '</span>';
            }
        }
        
        const realWeth = totalWeth - bscWeth;
        document.getElementById('wethLine').innerHTML = realWeth.toFixed(6) + ' WETH <span class="dim"> - $' + (realWeth * currentEthPrice).toFixed(2) + '</span>';
        document.getElementById('usdcLine').textContent = totalUsdc.toFixed(2) + ' USDC';

        // Render individual breakdown on Networks tab
        document.getElementById('netBaseEth').textContent = baseEth.toFixed(6) + ' ETH';
        document.getElementById('netBaseWeth').textContent = baseWeth.toFixed(6) + ' WETH';
        document.getElementById('netBaseUsdc').textContent = baseUsdc.toFixed(2) + ' USDC';

        document.getElementById('netPolyPol').textContent = polyPol.toFixed(6) + ' POL';
        document.getElementById('netPolyWeth').textContent = polyWeth.toFixed(6) + ' WETH';
        document.getElementById('netPolyUsdc').textContent = polyUsdc.toFixed(2) + ' USDC';

        const netArbEth = document.getElementById('netArbEth');
        if (netArbEth) netArbEth.textContent = arbEth.toFixed(6) + ' ETH';
        const netArbWeth = document.getElementById('netArbWeth');
        if (netArbWeth) netArbWeth.textContent = arbWeth.toFixed(6) + ' WETH';
        const netArbUsdc = document.getElementById('netArbUsdc');
        if (netArbUsdc) netArbUsdc.textContent = arbUsdc.toFixed(2) + ' USDC';

        const netOpEth = document.getElementById('netOpEth');
        if (netOpEth) netOpEth.textContent = opEth.toFixed(6) + ' ETH';
        const netOpWeth = document.getElementById('netOpWeth');
        if (netOpWeth) netOpWeth.textContent = opWeth.toFixed(6) + ' WETH';
        const netOpUsdc = document.getElementById('netOpUsdc');
        if (netOpUsdc) netOpUsdc.textContent = opUsdc.toFixed(2) + ' USDC';

        const netBscBnb = document.getElementById('netBscBnb');
        if (netBscBnb) netBscBnb.textContent = bscBnb.toFixed(6) + ' BNB';
        const netBscWeth = document.getElementById('netBscWeth');
        if (netBscWeth) netBscWeth.textContent = bscWeth.toFixed(6) + ' WBNB';
        const netBscUsdc = document.getElementById('netBscUsdc');
        if (netBscUsdc) netBscUsdc.textContent = bscUsdc.toFixed(2) + ' USDC';

        const netLineaEth = document.getElementById('netLineaEth');
        if (netLineaEth) netLineaEth.textContent = lineaEth.toFixed(6) + ' ETH';
        const netLineaWeth = document.getElementById('netLineaWeth');
        if (netLineaWeth) netLineaWeth.textContent = lineaWeth.toFixed(6) + ' WETH';
        const netLineaUsdc = document.getElementById('netLineaUsdc');
        if (netLineaUsdc) netLineaUsdc.textContent = lineaUsdc.toFixed(2) + ' USDC';

        // Update Base Relay deployment card dynamically
        try {
            const baseAddrs = await window.wallet.baseAddresses();
            const baseRelay = baseAddrs.relay;
            const baseProxy = baseAddrs.proxy;
            const baseDeployedCard = document.getElementById('baseDeployedCard');
            if (baseDeployedCard && baseRelay) {
                document.getElementById('netBaseRelayAddr').textContent = baseRelay.slice(0, 10) + '...' + baseRelay.slice(-8);
                document.getElementById('netBaseRelayAddr').title = baseRelay;
                document.getElementById('netBaseRelayAddr').onclick = () => {
                    window.open('https://basescan.org/address/' + baseRelay, '_blank');
                };
                
                const baseProxyEl = document.getElementById('netBaseProxyAddr');
                if (baseProxyEl && baseProxy) {
                    baseProxyEl.textContent = baseProxy.slice(0, 10) + '...' + baseProxy.slice(-8);
                    baseProxyEl.title = baseProxy;
                    baseProxyEl.onclick = () => {
                        window.open('https://basescan.org/address/' + baseProxy, '_blank');
                    };
                }
            }
        } catch (err) {
            console.error('Base addresses loading failed:', err);
        }

        // Update Polygon Relay deployment card dynamically
        const polyAddrs = await window.wallet.polygonAddresses();
        const polyRelay = polyAddrs.relay;
        const polyProxy = polyAddrs.proxy;
        const deployCard = document.getElementById('polyDeployCard');
        const deployedCard = document.getElementById('polyDeployedCard');
        
        if (deployedCard) {
            deployedCard.classList.remove('hidden');
            const relayEl = document.getElementById('netPolyRelayAddr');
            if (relayEl) {
                if (polyRelay && polyRelay !== '') {
                    relayEl.textContent = polyRelay.slice(0, 10) + '...' + polyRelay.slice(-8);
                    relayEl.title = polyRelay;
                    relayEl.style.color = 'var(--cyan)';
                    relayEl.style.cursor = 'pointer';
                    relayEl.onclick = () => {
                        window.open('https://polygonscan.com/address/' + polyRelay, '_blank');
                    };
                } else {
                    relayEl.textContent = 'Pending Deployment';
                    relayEl.title = 'Pending deployment of custom relay contract';
                    relayEl.style.color = 'var(--amber)';
                    relayEl.style.cursor = 'default';
                    relayEl.onclick = null;
                }
            }
            
            const proxyEl = document.getElementById('netPolyProxyAddr');
            if (proxyEl) {
                if (polyProxy && polyProxy !== '') {
                    proxyEl.textContent = polyProxy.slice(0, 10) + '...' + polyProxy.slice(-8);
                    proxyEl.title = polyProxy;
                    proxyEl.style.color = 'var(--cyan)';
                    proxyEl.style.cursor = 'pointer';
                    proxyEl.onclick = () => {
                        window.open('https://polygonscan.com/address/' + polyProxy, '_blank');
                    };
                } else {
                    proxyEl.textContent = 'Pending Deployment';
                    proxyEl.title = 'Pending deployment of custom proxy contract';
                    proxyEl.style.color = 'var(--amber)';
                    proxyEl.style.cursor = 'default';
                    proxyEl.onclick = null;
                }
            }
        }
        
        if (polyRelay && polyRelay !== '') {
            if (deployCard) deployCard.classList.add('hidden');
        } else {
            if (deployCard) deployCard.classList.remove('hidden');
        }

        // Helper function for rendering deployment cards dynamically
        const updateDeployCard = async (prefix, fetchFunc, explorerBase) => {
            try {
                if (!fetchFunc) return;
                const addrs = await fetchFunc();
                const relay = addrs.relay;
                const proxy = addrs.proxy;
                const deployCard = document.getElementById(`${prefix}DeployCard`);
                const deployedCard = document.getElementById(`${prefix}DeployedCard`);
                
                if (deployedCard) {
                    deployedCard.classList.remove('hidden');
                    const relayEl = document.getElementById(`net${prefix.charAt(0).toUpperCase() + prefix.slice(1)}RelayAddr`);
                    if (relayEl) {
                        if (relay && relay !== '') {
                            relayEl.textContent = relay.slice(0, 10) + '...' + relay.slice(-8);
                            relayEl.title = relay;
                            relayEl.style.color = 'var(--cyan)';
                            relayEl.style.cursor = 'pointer';
                            relayEl.onclick = () => window.open(explorerBase + 'address/' + relay, '_blank');
                        } else {
                            relayEl.textContent = 'Pending Deployment';
                            relayEl.title = 'Pending deployment of custom relay contract';
                            relayEl.style.color = 'var(--amber)';
                            relayEl.style.cursor = 'default';
                            relayEl.onclick = null;
                        }
                    }
                    
                    const proxyEl = document.getElementById(`net${prefix.charAt(0).toUpperCase() + prefix.slice(1)}ProxyAddr`);
                    if (proxyEl) {
                        if (proxy && proxy !== '') {
                            proxyEl.textContent = proxy.slice(0, 10) + '...' + proxy.slice(-8);
                            proxyEl.title = proxy;
                            proxyEl.style.color = 'var(--cyan)';
                            proxyEl.style.cursor = 'pointer';
                            proxyEl.onclick = () => window.open(explorerBase + 'address/' + proxy, '_blank');
                        } else {
                            proxyEl.textContent = 'Pending Deployment';
                            proxyEl.title = 'Pending deployment of custom proxy contract';
                            proxyEl.style.color = 'var(--amber)';
                            proxyEl.style.cursor = 'default';
                            proxyEl.onclick = null;
                        }
                    }
                }
                
                if (deployCard) {
                    if (relay && relay !== '') {
                        deployCard.classList.add('hidden');
                    } else {
                        deployCard.classList.remove('hidden');
                    }
                }
            } catch (e) {
                console.error(`Failed updating deployment card for ${prefix}:`, e);
            }
        };

        if (window.wallet.arbitrumAddresses) {
            await updateDeployCard('arb', window.wallet.arbitrumAddresses, 'https://arbiscan.io/');
        }
        if (window.wallet.optimismAddresses) {
            await updateDeployCard('op', window.wallet.optimismAddresses, 'https://optimistic.etherscan.io/');
        }
        if (window.wallet.bscAddresses) {
            await updateDeployCard('bsc', window.wallet.bscAddresses, 'https://bscscan.com/');
        }
        if (window.wallet.lineaAddresses) {
            await updateDeployCard('linea', window.wallet.lineaAddresses, 'https://lineascan.build/');
        }

    } catch (e) {
        document.getElementById('totalUsd').textContent = 'Error';
        document.getElementById('ethLine').textContent = '-- ETH';
        document.getElementById('polLine').textContent = '-- POL';
        const bnbLine = document.getElementById('bnbLine');
        if (bnbLine) bnbLine.textContent = '-- BNB';
        document.getElementById('wethLine').textContent = '-- WETH';
        document.getElementById('usdcLine').textContent = '-- USDC';
        ethBalance = 0;
    }
}

// =============================================================================
// SEND ETH / ERC-20
// =============================================================================
async function sendEth() {
    const netKey = document.getElementById('sendNetwork').value;
    const token = document.getElementById('sendToken').value;
    const to = document.getElementById('sendTo').value.trim();
    const amount = document.getElementById('sendAmount').value.trim();
    const resultEl = document.getElementById('sendResult');
    if (!to || !to.startsWith('0x') || to.length !== 42) {
        resultEl.innerHTML = '<span class="result-err">Invalid address</span>';
        toast('Invalid destination address', 'error');
        return;
    }
    if (!amount || parseFloat(amount) <= 0) {
        resultEl.innerHTML = '<span class="result-err">Invalid amount</span>';
        toast('Invalid amount', 'error');
        return;
    }
    const symbol = token === 'native'
        ? (netKey === 'polygon' ? 'POL' : (netKey === 'bsc' ? 'BNB' : 'ETH'))
        : (token === 'weth' && netKey === 'bsc' ? 'WBNB' : token.toUpperCase());
    resultEl.innerHTML = '<span class="sending">Sending ' + symbol + '...</span>';
    try {
        const res = await window.wallet.send(to, amount, netKey, token);
        if (res.error) {
            resultEl.innerHTML = '<span class="result-err">' + res.error + '</span>';
            toast(res.error, 'error');
            return;
        }
        resultEl.innerHTML = '<span class="result-ok">✅ Sent ' + amount + ' ' + symbol + '</span>';
        toast('Transaction sent! ' + amount + ' ' + symbol, 'success');
        setTimeout(refreshBalance, 3000);
        setTimeout(refreshTxHistory, 3000);
    } catch (e) {
        resultEl.innerHTML = '<span class="result-err">' + e.message + '</span>';
        toast(e.message, 'error');
    }
}

// =============================================================================
// LIVE TRANSACTION FEED
// =============================================================================
function startLiveFeed() {
    refreshTxHistory();
    const dot = document.getElementById('liveDot');
    if (dot) dot.style.display = 'inline-block';
    stopLiveFeed(); // clear any existing
    liveFeedInterval = setInterval(refreshTxHistory, 10000);
}

function stopLiveFeed() {
    if (liveFeedInterval) { clearInterval(liveFeedInterval); liveFeedInterval = null; }
    const dot = document.getElementById('liveDot');
    if (dot) dot.style.display = 'none';
}

// =============================================================================
// TX HISTORY
// =============================================================================
async function refreshTxHistory() {
    try {
        const res = await window.wallet.txHistory();
        const el = document.getElementById('txList');
        if (!res || !res.txs || res.txs.length === 0) {
            el.innerHTML = '<div class="tx-empty">Waiting for transactions...</div>';
            return;
        }
        const netKey = document.getElementById('relayNetwork').value;
        const userAddress = document.getElementById('addr').textContent.toLowerCase();
        
        // Filter by active network
        const filtered = res.txs.filter(tx => tx.network.toLowerCase() === (netKey === 'polygon' ? 'polygon' : 'base'));
        if (filtered.length === 0) {
            el.innerHTML = '<div class="tx-empty">No transactions on ' + (netKey === 'polygon' ? 'Polygon' : 'Base') + ' yet</div>';
            return;
        }
        
        // Slice the filtered list to a maximum of 15 entries for display
        const displayedTxs = filtered.slice(0, 15);
        
        el.innerHTML = displayedTxs.map(function (tx) {
            const isIn = tx.to.toLowerCase() === userAddress;
            const cls = isIn ? 'tx-in' : 'tx-out';
            const arrow = isIn ? '↓' : '↑';
            const symbol = tx.symbol || (tx.network === 'Polygon' ? 'POL' : 'ETH');
            const val = parseFloat(tx.value).toFixed(4);
            const shortHash = tx.hash.slice(0, 6) + '...' + tx.hash.slice(-4);
            
            const explorer = tx.network === 'Polygon' ? 'https://polygonscan.com/tx/' : 'https://basescan.org/tx/';
            const badgeColor = tx.network === 'Polygon' ? 'rgba(130, 71, 229, 0.15)' : 'rgba(0, 82, 255, 0.15)';
            const textColor = tx.network === 'Polygon' ? '#8247e5' : '#0052ff';
            
            let displayMethod = tx.method || '';
            // If method is hex selector or empty, fallback
            if (displayMethod.startsWith('0x')) {
                displayMethod = '';
            }
            
            // Map common Solidity/Router functions to nice readable labels
            const methodMap = {
                'depositV3': 'Bridge Out',
                'exactInputSingle': 'Swap',
                'swapExactTokensForTokens': 'Swap',
                'swapExactETHForTokens': 'Swap',
                'deposit': 'Wrap',
                'withdraw': 'Unwrap',
                'approve': 'Approve',
                'airdrop': 'Airdrop',
                'transfer': 'Transfer'
            };
            
            if (methodMap[displayMethod]) {
                displayMethod = methodMap[displayMethod];
            }
            
            // Guess clean context if method is generic/empty
            if (!displayMethod || displayMethod === 'Transfer') {
                if (isIn) {
                    displayMethod = (symbol === 'USDC' && tx.network === 'Base') ? 'Bridge In' : 'Receive';
                } else {
                    displayMethod = 'Send';
                }
            }
            
            const methodLabel = '<span style="font-size:9px;background:rgba(255,255,255,0.06);color:var(--text2);padding:1px 4px;border-radius:4px;font-family:var(--mono);font-weight:500;">' + displayMethod + '</span>';
            
            return '<div class="tx-row" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;">' +
                   '<div style="display:flex;align-items:center;gap:6px;">' +
                   '<span class="' + cls + '">' + arrow + ' ' + val + ' ' + symbol + '</span>' +
                   methodLabel +
                   '<span style="font-size:9px;background:' + badgeColor + ';color:' + textColor + ';padding:1px 4px;border-radius:4px;font-weight:700;">' + tx.network + '</span>' +
                   '</div>' +
                   '<span class="tx-hash" onclick="window.open(\'' + explorer + tx.hash + '\', \'_blank\')">' + shortHash + '</span>' +
                   '</div>';
        }).join('');
    } catch (e) { }
}

// =============================================================================
// RELAY TAB
// =============================================================================
async function refreshRelay() {
    const netKey = document.getElementById('relayNetwork').value;
    const symbol = netKey === 'polygon' ? 'POL' : (netKey === 'bsc' ? 'BNB' : 'ETH');
    const wrappedSymbol = netKey === 'bsc' ? 'WBNB' : 'WETH';
    
    // 1. Instant synchronous UI updates
    const labelEl = document.getElementById('relayNativeLabel');
    if (labelEl) labelEl.textContent = symbol;
    
    const wethLabelEl = document.getElementById('relayWethLabel');
    if (wethLabelEl) wethLabelEl.textContent = wrappedSymbol;
    
    const sweepBtn = document.getElementById('sweepBtn');
    if (sweepBtn) {
        if (netKey === 'base') {
            sweepBtn.textContent = 'Sweep All to Base USDC';
        } else {
            sweepBtn.textContent = 'Sweep & Bridge to Base USDC';
        }
    }

    // 2. Fetch Native balance
    try {
        const b = await window.wallet.balance();
        const eth = b[netKey]?.eth ? parseFloat(b[netKey].eth).toFixed(6) : '0.000000';
        document.getElementById('relayEthBal').textContent = eth + ' ' + symbol;
    } catch (e) {
        document.getElementById('relayEthBal').textContent = '-- ' + symbol;
    }

    // 3. Fetch WETH balance
    try {
        const wb = await window.wallet.relayWethBalance();
        const weth = parseFloat(wb[netKey]) || 0;
        document.getElementById('relayWethBal').textContent = weth.toFixed(6);
    } catch (e) {
        document.getElementById('relayWethBal').textContent = '--';
    }

    // 4. Fetch USDC balance
    try {
        const ub = await window.wallet.usdcBalance();
        const usdc = parseFloat(ub[netKey]) || 0;
        const usdcEl = document.getElementById('relayUsdcBal');
        if (usdcEl) usdcEl.textContent = usdc > 0 ? usdc.toFixed(2) + ' USDC' : '--';
    } catch (e) {
        const usdcEl = document.getElementById('relayUsdcBal');
        if (usdcEl) usdcEl.textContent = '--';
    }
    
    // Auto-update transaction history filtered for this network
    refreshTxHistory();
}

async function sweepAllNetworks() {
    const btn = document.getElementById('sweepBtn');
    const resultEl = document.getElementById('sweepResult');
    const networks = ['base', 'polygon', 'arbitrum', 'optimism', 'bsc', 'linea'];

    // Reset all rows
    networks.forEach(net => {
        const row = document.getElementById('sweep-row-' + net);
        if (!row) return;
        row.className = 'sweep-row';
        row.querySelector('.sweep-row-status').textContent = 'idle';
        row.querySelector('.sweep-row-status').style.color = 'var(--text2)';
        const amtEl = row.querySelector('.sweep-row-amount');
        amtEl.style.display = 'none';
        amtEl.textContent = '';
    });
    const baseRow = document.getElementById('sweep-row-base');
    if (baseRow) {
        baseRow.className = 'sweep-row sweep-active';
        baseRow.querySelector('.sweep-row-status').textContent = 'sweeping local…';
        baseRow.querySelector('.sweep-row-status').style.color = '#00d2ff';
        const amtEl = baseRow.querySelector('.sweep-row-amount');
        amtEl.style.display = 'none';
        amtEl.textContent = '';
    }

    btn.disabled = true;
    btn.textContent = '⏳ Sweeping...';
    resultEl.innerHTML = '';

    let totalUsdc = 0;
    let anySuccess = false;
    let skippedCount = 0;
    let gasNeededCount = 0;

    for (const net of networks) {
        const row = document.getElementById('sweep-row-' + net);
        const statusEl = row ? row.querySelector('.sweep-row-status') : null;
        const amtEl = row ? row.querySelector('.sweep-row-amount') : null;

        // Activate row
        if (row) { row.className = 'sweep-row sweep-active'; }
        if (statusEl) { statusEl.textContent = 'sweeping…'; statusEl.style.color = '#00d2ff'; }

        try {
            let res;
            if (net === 'base')       res = await window.wallet.sweepToUsdc('base');
            else if (net === 'polygon')  res = await window.wallet.bridgePolygonToBase();
            else if (net === 'arbitrum') res = await window.wallet.bridgeArbitrumToBase();
            else if (net === 'optimism') res = await window.wallet.bridgeOptimismToBase();
            else if (net === 'bsc')      res = await window.wallet.bridgeBscToBase();
            else if (net === 'linea')    res = await window.wallet.bridgeLineaToBase();

            if (res && res.status === 'success') {
                // GREEN - successful swap/bridge
                const amt = parseFloat(res.amount || '0');
                totalUsdc += amt;
                anySuccess = true;
                if (row) row.className = 'sweep-row sweep-done';
                if (statusEl) { statusEl.textContent = '✓ swapped'; statusEl.style.color = 'var(--green)'; }
                if (amtEl && amt > 0) { amtEl.textContent = '+' + amt.toFixed(4) + ' ETH'; amtEl.style.display = ''; }
                else if (statusEl) { statusEl.textContent = '✓ done'; }
            } else if (res && res.status === 'skipped') {
                // GREY - nothing to do, not an error
                skippedCount++;
                if (row) row.className = 'sweep-row sweep-skipped';
                if (statusEl) { statusEl.textContent = '— empty'; statusEl.style.color = 'var(--dim)'; }
                if (amtEl) { amtEl.textContent = ''; amtEl.style.display = 'none'; }
            } else if (res && res.status === 'gas_needed') {
                // AMBER - needs attention but not broken
                gasNeededCount++;
                if (row) row.className = 'sweep-row sweep-gas';
                if (statusEl) { statusEl.textContent = '⛽ needs gas'; statusEl.style.color = '#ffaa00'; statusEl.title = res.reason; }
                if (amtEl) { amtEl.textContent = ''; amtEl.style.display = 'none'; }
            } else if (res && res.error) {
                // RED - actual error
                if (row) row.className = 'sweep-row sweep-error';
                if (statusEl) { statusEl.textContent = '✗ failed'; statusEl.style.color = '#ff5050'; statusEl.title = res.error; }
                if (amtEl) { amtEl.textContent = ''; amtEl.style.display = 'none'; }
            } else {
                // GREY - unknown/empty
                skippedCount++;
                if (row) row.className = 'sweep-row sweep-skipped';
                if (statusEl) { statusEl.textContent = '— empty'; statusEl.style.color = 'var(--dim)'; }
            }
        } catch (e) {
            if (row) row.className = 'sweep-row sweep-error';
            if (statusEl) { statusEl.textContent = '✗ failed'; statusEl.style.color = '#ff5050'; statusEl.title = e.message; }
        }
    }

    // Update base row to collecting state after all sweeps
    if (baseRow) {
        baseRow.className = 'sweep-row sweep-done';
        const statusEl = baseRow.querySelector('.sweep-row-status');
        const amtEl = baseRow.querySelector('.sweep-row-amount');
        statusEl.textContent = '✓ collecting';
        statusEl.style.color = 'var(--green)';
        if (totalUsdc > 0) {
            amtEl.textContent = '+' + totalUsdc.toFixed(2) + ' USDC incoming';
            amtEl.style.display = '';
        }
    }

    btn.disabled = false;
    btn.textContent = '⚡ Sweep All to Base USDC';

    if (anySuccess) {
        resultEl.innerHTML = '<span class="result-ok">✅ Sweep complete — ' + totalUsdc.toFixed(2) + ' USDC bridging to Base</span>';
        toast('Sweep complete! ' + totalUsdc.toFixed(2) + ' USDC bridging to Base.', 'success');
    } else if (gasNeededCount > 0) {
        resultEl.innerHTML = '<span style="color:#ffaa00;">' + gasNeededCount + ' chain' + (gasNeededCount > 1 ? 's' : '') + ' need gas — send ~0.001 ETH to continue</span>';
        toast(gasNeededCount + ' chain(s) need gas to sweep.', 'info');
    } else {
        resultEl.innerHTML = '<span style="color:var(--dim);">All chains empty — nothing to sweep</span>';
    }

    refreshRelay();
    refreshBalance();
    refreshTxHistory();
    setTimeout(() => { refreshRelay(); refreshBalance(); }, 5000);
}

async function sweepToUsdc() {
    const netKey = document.getElementById('relayNetwork').value;
    const resultEl = document.getElementById('sweepResult');
    
    if (netKey === 'polygon') {
        resultEl.innerHTML = '<span class="sending">Sweeping & Bridging all Polygon assets to Base USDC... (swapping WETH, POL, USDC.e -> native USDC, then depositing to Across)</span>';
        toast('Starting Polygon-to-Base sweep & bridge sequence...', 'info');
        try {
            const res = await window.wallet.bridgePolygonToBase();
            if (res.error) {
                resultEl.innerHTML = '<span class="result-err">' + res.error + '</span>';
                toast(res.error, 'error');
                return;
            }
            resultEl.innerHTML = '<span class="result-ok">✅ Swept & Bridged!<br>Amount: ' + res.amount + ' USDC<br>Tx Hash: ' + res.txs[res.txs.length - 1].hash.slice(0, 10) + '...</span>';
            toast('Sweep and bridge deposit confirmed!', 'success');
            
            // Immediate UX update, followed by block indexing sync loops
            refreshRelay();
            refreshBalance();
            refreshTxHistory();
            setTimeout(refreshRelay, 3000);
            setTimeout(refreshBalance, 3000);
            setTimeout(() => {
                refreshRelay();
                refreshBalance();
                refreshTxHistory();
            }, 6000);
        } catch (e) {
            resultEl.innerHTML = '<span class="result-err">' + e.message + '</span>';
            toast(e.message, 'error');
        }
        return;
    }
    
    if (netKey === 'arbitrum' || netKey === 'optimism' || netKey === 'bsc' || netKey === 'linea') {
        const netName = { arbitrum: 'Arbitrum', optimism: 'Optimism', bsc: 'BSC', linea: 'Linea' }[netKey];
        resultEl.innerHTML = '<span class="sending">Sweeping & Bridging all ' + netName + ' assets to Base USDC... (swapping native & wrapped, then depositing to bridge)</span>';
        toast('Starting ' + netName + '-to-Base sweep & bridge sequence...', 'info');
        try {
            let res;
            if (netKey === 'arbitrum') res = await window.wallet.bridgeArbitrumToBase();
            if (netKey === 'optimism') res = await window.wallet.bridgeOptimismToBase();
            if (netKey === 'bsc') res = await window.wallet.bridgeBscToBase();
            if (netKey === 'linea') res = await window.wallet.bridgeLineaToBase();
            
            if (res.error) {
                resultEl.innerHTML = '<span class="result-err">' + res.error + '</span>';
                toast(res.error, 'error');
                return;
            }
            const hash = res.txs && res.txs.length > 0 ? res.txs[res.txs.length - 1].hash : 'unknown';
            resultEl.innerHTML = '<span class="result-ok">✅ Swept & Bridged!<br>Amount: ' + res.amount + ' USDC<br>Tx Hash: ' + hash.slice(0, 10) + '...</span>';
            toast('Sweep and bridge deposit confirmed!', 'success');
            refreshRelay();
            refreshBalance();
            refreshTxHistory();
        } catch (e) {
            resultEl.innerHTML = '<span class="result-err">' + e.message + '</span>';
            toast(e.message, 'error');
        }
        return;
    }

    resultEl.innerHTML = '<span class="sending">Sweeping ETH/WETH to USDC on ' + netKey.toUpperCase() + '...</span>';
    try {
        const res = await window.wallet.sweepToUsdc(netKey);
        if (res.error) {
            resultEl.innerHTML = '<span class="result-err">' + res.error + '</span>';
            toast(res.error, 'error');
            return;
        }
        resultEl.innerHTML = '<span class="result-ok">✅ Swept ' + (res.amount || 'assets') + ' to USDC</span>';
        toast('Sweep complete!', 'success');
        
        // Immediate UX update, followed by block indexing sync loops
        refreshRelay();
        refreshBalance();
        refreshTxHistory();
        setTimeout(refreshRelay, 3000);
        setTimeout(refreshBalance, 3000);
        setTimeout(() => {
            refreshRelay();
            refreshBalance();
            refreshTxHistory();
        }, 6000);
    } catch (e) {
        resultEl.innerHTML = '<span class="result-err">' + e.message + '</span>';
        toast(e.message, 'error');
    }
}

// Individual boost swaps removed — consolidated into smart sweep flow.

// =============================================================================
// LOCK
// =============================================================================
async function lock() {
    if (balanceInterval) { clearInterval(balanceInterval); balanceInterval = null; }
    if (priceInterval) { clearInterval(priceInterval); priceInterval = null; }
    stopLiveFeed();
    ethPrice = 3100.00;
    polPrice = 0.45;
    ethBalance = 0;
    await window.wallet.lock();
    window.wallet.resizeWindow(380, 260);
    unlockedEl.classList.add('hidden');
    lockedEl.classList.remove('hidden');
    document.getElementById('unlockPw').value = '';
    document.getElementById('qrImg').src = '';
    document.getElementById('txList').innerHTML = '<div class="tx-empty">Waiting for transactions...</div>';
}

// =============================================================================
// COPY ADDRESS
// =============================================================================
async function copyAddr() {
    const addr = document.getElementById('addr').textContent;
    try { await navigator.clipboard.writeText(addr); } catch (e) {
        const ta = document.createElement('textarea'); ta.value = addr; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    }
    toast('Address copied to clipboard', 'success');
    const btn = document.querySelector('.copy-btn');
    const orig = btn.textContent;
    btn.textContent = '✅ Copied!';
    setTimeout(function () { btn.textContent = orig; }, 2000);
}

async function updateQrCode() {
    const netKey = document.getElementById('sendNetwork').value;
    const addr = document.getElementById('addr').textContent;
    if (!addr || addr === '0x...') return;
    
    const chainIds = {
        base: '8453',
        polygon: '137',
        arbitrum: '42161',
        optimism: '10',
        bsc: '56'
    };
    const chainId = chainIds[netKey] || '8453';
    
    try {
        const qr = await window.wallet.generateQR('ethereum:' + addr + '@' + chainId);
        if (qr && !qr.error) document.getElementById('qrImg').src = qr;
    } catch (e) { }
}

// =============================================================================
// MAX BUTTONS — fill input with available balance
// =============================================================================
function setMaxSend() {
    const netKey = document.getElementById('sendNetwork').value;
    const token = document.getElementById('sendToken').value;
    let bal = 0;
    if (token === 'native') {
        bal = window.balances?.[netKey]?.eth || 0;
        const buffer = netKey === 'bsc' ? 0.005 : (netKey === 'polygon' ? 0.2 : 0.0003);
        const max = Math.max(0, bal - buffer);
        document.getElementById('sendAmount').value = max > 0 ? max.toFixed(6) : '0';
    } else if (token === 'usdc') {
        bal = window.balances?.[netKey]?.usdc || 0;
        document.getElementById('sendAmount').value = bal > 0 ? bal.toFixed(2) : '0';
    } else if (token === 'weth') {
        bal = window.balances?.[netKey]?.weth || 0;
        document.getElementById('sendAmount').value = bal > 0 ? bal.toFixed(6) : '0';
    }
    estimateGas();
}

function setMaxSendLabel() {
    const netKey = document.getElementById('sendNetwork').value;
    const sendTokenSelect = document.getElementById('sendToken');
    if (sendTokenSelect) {
        // Option 0: Native
        const nativeOpt = sendTokenSelect.options[0];
        if (nativeOpt) {
            if (netKey === 'polygon') {
                nativeOpt.textContent = 'Native (POL)';
            } else if (netKey === 'bsc') {
                nativeOpt.textContent = 'Native (BNB)';
            } else {
                nativeOpt.textContent = 'Native (ETH)';
            }
        }
        
        // Option 2: Wrapped
        const wrappedOpt = sendTokenSelect.options[2];
        if (wrappedOpt) {
            if (netKey === 'bsc') {
                wrappedOpt.textContent = 'WBNB';
            } else {
                wrappedOpt.textContent = 'WETH';
            }
        }
    }
    estimateGas();
}


// Max boost and live USD conversions removed — consolidated into smart sweep flow.

// =============================================================================
// GAS ESTIMATION for send
// =============================================================================
async function estimateGas() {
    const netKey = document.getElementById('sendNetwork').value;
    const to = document.getElementById('sendTo').value.trim();
    const amount = document.getElementById('sendAmount').value || '0.001';
    const hint = document.getElementById('gasHint');
    if (!to || !to.startsWith('0x') || to.length !== 42) {
        hint.textContent = '';
        return;
    }
    try {
        const res = await window.wallet.estimateGas(to, amount, netKey);
        if (res && !res.error && res.gasCostEth) {
            hint.textContent = 'Est. gas: ~' + parseFloat(res.gasCostEth).toFixed(6) + ' ETH';
        }
    } catch (e) { hint.textContent = ''; }
}

// Attach gas estimation to input changes
(function () {
    var sendToEl = document.getElementById('sendTo');
    var sendAmtEl = document.getElementById('sendAmount');
    if (sendToEl) sendToEl.addEventListener('input', estimateGas);
    if (sendAmtEl) sendAmtEl.addEventListener('input', estimateGas);
})();

// =============================================================================
// EXPORT PRIVATE KEY — copies to clipboard, logs to DevTools console
// =============================================================================
async function exportPrivateKey() {
    try {
        // Try direct export first (wallet already unlocked)
        var result = await window.wallet.exportKey();
        if (result.error) {
            // Fall back to password-gated export
            var pw = prompt('Enter wallet password to export key:');
            if (!pw) return;
            result = await window.wallet.exportKeyWithPassword(pw);
        }
        if (result.error) {
            toast(result.error, 'error');
            return;
        }
        // Copy to clipboard
        try { await navigator.clipboard.writeText(result.privateKey); } catch (e) {
            var ta = document.createElement('textarea'); ta.value = result.privateKey;
            ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        }
        toast('✅ Key copied to clipboard. Check DevTools console too.', 'success');
        // Also log to console for easy copy
        console.log('PRIVATE_KEY=' + result.privateKey);
        console.log('ADDRESS=' + result.address);
        console.log('^^ Copy the PRIVATE_KEY line above for Hardhat .env');
    } catch (e) {
        toast('Export failed: ' + e.message, 'error');
    }
}

// =============================================================================
// AUTOMATED POLYGON DEPLOYMENT & BRIDGING
// =============================================================================
async function deployPolygonRelay() {
    const btn = document.getElementById('deployPolyBtn');
    const statusEl = document.getElementById('deployPolyStatus');
    if (!btn || !statusEl) return;

    btn.disabled = true;
    statusEl.innerHTML = '<span class="sending">Deploying contracts to Polygon PoS... (takes ~60-90s)</span>';
    toast('Starting Polygon deployment script...', 'info');

    try {
        const result = await window.wallet.deployPolygon();
        if (result.error) {
            statusEl.innerHTML = '<span class="result-err">Error: ' + result.error.replace(/\n/g, '<br>') + '</span>';
            toast('Deployment failed!', 'error');
            btn.disabled = false;
        } else {
            statusEl.innerHTML = '<span class="result-ok">✅ Deployed successfully!<br>Relay: ' + result.relay + '<br>Proxy: ' + result.proxy + '</span>';
            toast('Relay deployed to Polygon!', 'success');
            await refreshBalance();
            await refreshRelay();
        }
    } catch (e) {
        statusEl.innerHTML = '<span class="result-err">Execution error: ' + e.message + '</span>';
        toast('Execution failed: ' + e.message, 'error');
        btn.disabled = false;
    }
}

// bridgePolygonUsdc removed — consolidated into sweepToUsdc flow.

// =============================================================================
// INIT — dev auto-unlock (bypass PIN/password), fallback to normal flow
// =============================================================================
(async () => {
    try {
        const exists = await window.wallet.exists();
        if (exists) {
            try {
                const result = await window.wallet.devUnlock();
                if (result && result.address) {
                    showUnlocked(result.address);
                    return;
                }
            } catch (e) { /* devKey not available or in production, fall through to PIN */ }
            newWalletEl.classList.add('hidden');
            existingWalletEl.classList.remove('hidden');
        } else {
            newWalletEl.classList.remove('hidden');
            existingWalletEl.classList.add('hidden');
        }
    } catch (e) { }
})();

// =============================================================================
// ADDRESS BOOK FRONTEND LOGIC
// =============================================================================
async function loadAddressBook() {
    try {
        const book = await window.wallet.getAddressBook();
        const dropdown = document.getElementById('addressBookDropdown');
        if (!dropdown) return;
        
        // Keep the first option ("Addresses 📖")
        dropdown.innerHTML = '<option value="">Addresses 📖</option>';
        
        if (book && book.length > 0) {
            book.forEach(item => {
                const opt = document.createElement('option');
                opt.value = item.address;
                opt.textContent = item.label;
                opt.title = `${item.label}: ${item.address}`;
                dropdown.appendChild(opt);
            });
        }
    } catch (e) { console.error('Failed to load address book:', e); }
}

async function saveCurrentAddress() {
    const address = document.getElementById('sendTo').value.trim();
    if (!address || !address.startsWith('0x') || address.length !== 42) {
        toast('Enter a valid 0x address first', 'error');
        return;
    }

    try {
        const book = await window.wallet.getAddressBook();
        const existing = book.find(item => item.address.toLowerCase() === address.toLowerCase());
        
        if (existing) {
            const confirmDelete = confirm(`"${existing.label}" is already saved for this address. Do you want to delete/remove it from your address book?`);
            if (confirmDelete) {
                const res = await window.wallet.deleteAddress(address);
                if (res.error) {
                    toast(res.error, 'error');
                } else {
                    toast('Address removed from book', 'success');
                    await loadAddressBook();
                    document.getElementById('addressBookDropdown').value = '';
                }
                return;
            }
        }
    } catch (e) { console.error(e); }
    
    const label = prompt('Enter a label for this address (e.g., Hot Wallet, Exchange):');
    if (!label) return; // cancelled or empty
    
    try {
        const res = await window.wallet.saveAddress(label.trim(), address);
        if (res.error) {
            toast(res.error, 'error');
        } else {
            toast('Address saved to book!', 'success');
            await loadAddressBook();
        }
    } catch (e) { toast('Failed to save address: ' + e.message, 'error'); }
}

function selectSavedAddress() {
    const dropdown = document.getElementById('addressBookDropdown');
    if (!dropdown) return;
    const val = dropdown.value;
    if (val) {
        document.getElementById('sendTo').value = val;
        estimateGas(); // trigger gas estimation automatically
    }
}

// =============================================================================
// INTERACTIVE ASSET CARD SELECTION
// =============================================================================
function selectAsset(network, token, el) {
    // 1. Remove active-card highlight from all cards
    document.querySelectorAll('.asset-card').forEach(c => c.classList.remove('active-card'));
    
    // 2. Add active-card highlight to the selected card
    if (el) el.classList.add('active-card');

    // 3. Set values on hidden select dropdowns
    const netSelect = document.getElementById('sendNetwork');
    const tokenSelect = document.getElementById('sendToken');
    if (netSelect) netSelect.value = network;
    if (tokenSelect) tokenSelect.value = token;

    // 4. Update UX, gas estimation, QR, and MAX buttons
    estimateGas();
    updateQrCode();
    setMaxSendLabel();
}

function selectEthCard(el) {
    const nets = ['base', 'arbitrum', 'optimism', 'linea'];
    let bestNet = 'base';
    let maxBal = -1;
    for (const net of nets) {
        const bal = window.balances?.[net]?.eth || 0;
        if (bal > maxBal) {
            maxBal = bal;
            bestNet = net;
        }
    }
    selectAsset(bestNet, 'native', el);
}

function selectWethCard(el) {
    const nets = ['base', 'polygon', 'arbitrum', 'optimism', 'bsc', 'linea'];
    let bestNet = 'base';
    let maxBal = -1;
    for (const net of nets) {
        const bal = window.balances?.[net]?.weth || 0;
        if (bal > maxBal) {
            maxBal = bal;
            bestNet = net;
        }
    }
    selectAsset(bestNet, 'weth', el);
}

function selectUsdcCard(el) {
    const nets = ['base', 'polygon', 'arbitrum', 'optimism', 'bsc', 'linea'];
    let bestNet = 'base';
    let maxBal = -1;
    for (const net of nets) {
        const bal = window.balances?.[net]?.usdc || 0;
        if (bal > maxBal) {
            maxBal = bal;
            bestNet = net;
        }
    }
    selectAsset(bestNet, 'usdc', el);
}

function autoSelectHighestAsset() {
    let bestAsset = 'usdc';
    let maxVal = -1;

    const baseEth = window.balances?.base?.eth || 0;
    const polyPol = window.balances?.polygon?.eth || 0;
    const arbEth = window.balances?.arbitrum?.eth || 0;
    const opEth = window.balances?.optimism?.eth || 0;
    const bscBnb = window.balances?.bsc?.eth || 0;
    const lineaEth = window.balances?.linea?.eth || 0;

    const baseWeth = window.balances?.base?.weth || 0;
    const polyWeth = window.balances?.polygon?.weth || 0;
    const arbWeth = window.balances?.arbitrum?.weth || 0;
    const opWeth = window.balances?.optimism?.weth || 0;
    const bscWeth = window.balances?.bsc?.weth || 0;
    const lineaWeth = window.balances?.linea?.weth || 0;

    const baseUsdc = window.balances?.base?.usdc || 0;
    const polyUsdc = window.balances?.polygon?.usdc || 0;
    const arbUsdc = window.balances?.arbitrum?.usdc || 0;
    const opUsdc = window.balances?.optimism?.usdc || 0;
    const bscUsdc = window.balances?.bsc?.usdc || 0;
    const lineaUsdc = window.balances?.linea?.usdc || 0;

    const currentEthPrice = ethPrice || 1557.86;
    const currentPolPrice = polPrice || 0.0733;
    const currentBnbPrice = bnbPrice || 580.00;

    const totalEth = baseEth + arbEth + opEth + lineaEth;
    const totalWeth = baseWeth + polyWeth + arbWeth + opWeth + bscWeth + lineaWeth;
    const totalUsdc = baseUsdc + polyUsdc + arbUsdc + opUsdc + bscUsdc + lineaUsdc;

    const ethVal = totalEth * currentEthPrice;
    const polVal = polyPol * currentPolPrice;
    const bnbVal = bscBnb * currentBnbPrice;
    const wethVal = (baseWeth + polyWeth + arbWeth + opWeth + lineaWeth) * currentEthPrice + bscWeth * currentBnbPrice;
    const usdcVal = totalUsdc;

    if (ethVal > maxVal) { maxVal = ethVal; bestAsset = 'eth'; }
    if (polVal > maxVal) { maxVal = polVal; bestAsset = 'pol'; }
    if (bnbVal > maxVal) { maxVal = bnbVal; bestAsset = 'bnb'; }
    if (wethVal > maxVal) { maxVal = wethVal; bestAsset = 'weth'; }
    if (usdcVal > maxVal) { maxVal = usdcVal; bestAsset = 'usdc'; }

    let cardId = 'usdcCard';
    if (bestAsset === 'eth') cardId = 'ethCard';
    if (bestAsset === 'pol') cardId = 'polCard';
    if (bestAsset === 'bnb') cardId = 'bnbCard';
    if (bestAsset === 'weth') cardId = 'wethCard';
    if (bestAsset === 'usdc') cardId = 'usdcCard';

    const el = document.getElementById(cardId);
    if (el) {
        if (bestAsset === 'eth') {
            selectEthCard(el);
        } else if (bestAsset === 'pol') {
            selectAsset('polygon', 'native', el);
        } else if (bestAsset === 'bnb') {
            selectAsset('bsc', 'native', el);
        } else if (bestAsset === 'weth') {
            selectWethCard(el);
        } else if (bestAsset === 'usdc') {
            selectUsdcCard(el);
        }
    }
}

// =============================================================================
// CUSTOM BRIDGE FRONTEND LOGIC
// =============================================================================
function setMaxBridge() {
    const netKey = document.getElementById('bridgeSrcNetwork')?.value || document.getElementById('relayNetwork').value;
    const token = document.getElementById('bridgeAsset').value;
    let bal = 0;
    if (token === 'usdc') {
        bal = window.balances?.[netKey]?.usdc || 0;
        document.getElementById('bridgeAmount').value = bal > 0 ? bal.toFixed(2) : '0';
    } else if (token === 'weth') {
        bal = window.balances?.[netKey]?.weth || 0;
        document.getElementById('bridgeAmount').value = bal > 0 ? bal.toFixed(6) : '0';
    } else if (token === 'eth') {
        bal = window.balances?.[netKey]?.eth || 0;
        // L2 gas fees (Base, Arbitrum, Optimism, Linea) are tiny — 0.0003 ETH is a generous buffer
        const buffer = 0.0003;
        const max = Math.max(0, bal - buffer);
        document.getElementById('bridgeAmount').value = max > 0 ? max.toFixed(6) : '0';
    }
}

async function executeCustomBridge() {
    const fromKey = document.getElementById('bridgeSrcNetwork')?.value || document.getElementById('relayNetwork').value;
    const toKey = document.getElementById('bridgeDestNetwork').value;
    const token = document.getElementById('bridgeAsset').value;
    const amount = document.getElementById('bridgeAmount').value.trim();
    const resultEl = document.getElementById('bridgeResult');
    
    if (fromKey === toKey) {
        resultEl.innerHTML = '<span class="result-err">Source and destination must be different</span>';
        toast('Source and destination must be different', 'error');
        return;
    }
    if (!amount || parseFloat(amount) <= 0) {
        resultEl.innerHTML = '<span class="result-err">Invalid amount</span>';
        toast('Invalid amount', 'error');
        return;
    }
    // Minimum bridge amount check (Across has a ~$1 minimum)
    if (token === 'eth' && parseFloat(amount) < 0.0005) {
        resultEl.innerHTML = '<span class="result-err">Minimum bridge: 0.0005 ETH. Need more ETH on Base first.</span>';
        toast('Amount too small to bridge', 'error');
        return;
    }
    
    resultEl.innerHTML = '<span class="sending">Bridging ' + amount + ' ' + token.toUpperCase() + '...</span>';
    toast('Starting custom bridge deposit...', 'info');
    
    try {
        const res = await window.wallet.customBridge(fromKey, toKey, token, amount);
        if (res.error) {
            resultEl.innerHTML = '<span class="result-err">' + res.error + '</span>';
            toast(res.error, 'error');
            return;
        }
        resultEl.innerHTML = '<span class="result-ok">✅ Bridged ' + amount + ' ' + token.toUpperCase() + '!<br>Tx: ' + res.hash.slice(0, 10) + '...</span>';
        toast('Bridge transaction confirmed!', 'success');
        refreshRelay();
        refreshBalance();
        refreshTxHistory();
    } catch (e) {
        resultEl.innerHTML = '<span class="result-err">' + e.message + '</span>';
        toast(e.message, 'error');
    }
}

// =============================================================================
// DEPLOYER MODAL LOGIC
// =============================================================================
function openDeployerModal() {
    document.getElementById('deployModal').classList.remove('hidden');
    document.getElementById('deployerInfo').textContent = '';
    
    // Set the address in the modal
    const addr = document.getElementById('addr').textContent;
    const modalAddrEl = document.getElementById('deployerModalAddress');
    if (modalAddrEl && addr) {
        modalAddrEl.textContent = addr;
    }
    
    refreshDeployerModalStatus();
}

function closeDeployerModal() {
    document.getElementById('deployModal').classList.add('hidden');
}

async function refreshDeployerModalStatus() {
    const infoEl = document.getElementById('deployerInfo');
    if (infoEl && infoEl.textContent === '') {
        infoEl.innerHTML = '<span style="color:var(--cyan);">Scanning network gas balances...</span>';
    }
    
    // Scan for latest balances first
    try {
        await refreshBalance();
    } catch (e) {
        console.error('Failed refreshing balances for deployer modal:', e);
    }
    
    if (infoEl && infoEl.textContent === 'Scanning network gas balances...') {
        infoEl.textContent = '';
    }

    const networks = ['base', 'polygon', 'arbitrum', 'optimism', 'bsc', 'linea'];
    const fetchFuncs = {
        base: window.wallet.baseAddresses,
        polygon: window.wallet.polygonAddresses,
        arbitrum: window.wallet.arbitrumAddresses,
        optimism: window.wallet.optimismAddresses,
        bsc: window.wallet.bscAddresses,
        linea: window.wallet.lineaAddresses
    };
    
    const minGasRequirements = {
        base: 0.0005,
        polygon: 0.05,
        arbitrum: 0.0005,
        optimism: 0.0005,
        bsc: 0.002,
        linea: 0.0005
    };
    
    for (const net of networks) {
        try {
            const addrs = await fetchFuncs[net]();
            const relay = addrs.relay;
            const statusEl = document.getElementById('deployerStatus_' + net);
            const btnEl = document.getElementById('deployerBtn_' + net);
            
            if (statusEl && btnEl) {
                if (relay && relay !== '') {
                    statusEl.innerHTML = '<span style="color:var(--green);font-weight:600;">Active: </span><span style="color:var(--cyan);font-family:var(--mono);">' + relay.slice(0, 6) + '...' + relay.slice(-4) + '</span>';
                    btnEl.disabled = true;
                    btnEl.textContent = 'Deployed';
                    btnEl.style.background = 'rgba(255,255,255,0.05)';
                    btnEl.style.color = 'var(--text2)';
                    btnEl.style.borderColor = 'transparent';
                    btnEl.style.cursor = 'default';
                } else {
                    const bal = parseFloat(window.balances?.[net]?.eth || '0');
                    const symbol = net === 'polygon' ? 'POL' : (net === 'bsc' ? 'BNB' : 'ETH');
                    const minGas = minGasRequirements[net];
                    const isFunded = bal >= minGas;
                    
                    const balColor = isFunded ? 'var(--green)' : 'var(--red)';
                    statusEl.innerHTML = '<span style="color:var(--amber);font-weight:600;">Pending Deployment</span><br><span style="color:' + balColor + ';font-size:9.5px;font-weight:500;">Gas: ' + bal.toFixed(4) + ' / ' + minGas + ' ' + symbol + '</span>';
                    
                    if (isFunded) {
                        btnEl.disabled = false;
                        btnEl.textContent = 'Deploy';
                        btnEl.style.background = 'linear-gradient(135deg, var(--cyan), #0088cc)';
                        btnEl.style.color = '#06060d';
                        btnEl.style.cursor = 'pointer';
                    } else {
                        btnEl.disabled = true;
                        btnEl.textContent = 'Need Gas';
                        btnEl.style.background = 'rgba(255,255,255,0.03)';
                        btnEl.style.color = 'var(--dim)';
                        btnEl.style.cursor = 'not-allowed';
                    }
                }
            }
        } catch (e) {
            console.error('Failed fetching address status for ' + net, e);
        }
    }
}

async function runContractDeployment(net) {
    const btnEl = document.getElementById('deployerBtn_' + net);
    const statusEl = document.getElementById('deployerStatus_' + net);
    const infoEl = document.getElementById('deployerInfo');
    
    if (!btnEl || !statusEl) return;
    
    btnEl.disabled = true;
    btnEl.textContent = 'Deploying...';
    btnEl.style.background = 'rgba(255,255,255,0.05)';
    btnEl.style.color = 'var(--text2)';
    statusEl.innerHTML = '<span class="sending">Compiling & Deploying contract... (takes ~60s)</span>';
    infoEl.innerHTML = '<span style="color:var(--cyan);">Deploying custom relay contract to ' + net.toUpperCase() + ' Mainnet...</span>';
    toast('Starting deployment to ' + net.toUpperCase() + '... Please wait.', 'info');
    
    try {
        const res = await window.wallet.deployNetwork(net);
        if (res.error) {
            statusEl.innerHTML = '<span style="color:var(--red);font-weight:600;">❌ Failed</span>';
            infoEl.innerHTML = '<span style="color:var(--red);">Deployment failed: ' + res.error.replace(/\n/g, '<br>') + '</span>';
            toast('Deployment to ' + net.toUpperCase() + ' failed!', 'error');
            btnEl.disabled = false;
            btnEl.textContent = 'Deploy';
            btnEl.style.background = 'linear-gradient(135deg, var(--cyan), #0088cc)';
            btnEl.style.color = '#06060d';
        } else {
            statusEl.innerHTML = '<span style="color:var(--green);font-weight:600;">Active: </span><span style="color:var(--cyan);font-family:var(--mono);">' + res.relay.slice(0, 6) + '...' + res.relay.slice(-4) + '</span>';
            infoEl.innerHTML = '<span style="color:var(--green);">✅ Successfully deployed V3 Relay to ' + net.toUpperCase() + '!</span>';
            toast('Relay deployed to ' + net.toUpperCase() + '!', 'success');
            
            // Refresh address display and balances in UI
            await refreshBalance();
            await refreshRelay();
            await refreshDeployerModalStatus();
        }
    } catch (e) {
        statusEl.innerHTML = '<span style="color:var(--red);font-weight:600;">❌ Execution Error</span>';
        infoEl.innerHTML = '<span style="color:var(--red);">Error: ' + e.message + '</span>';
        toast('Execution error: ' + e.message, 'error');
        btnEl.disabled = false;
        btnEl.textContent = 'Deploy';
        btnEl.style.background = 'linear-gradient(135deg, var(--cyan), #0088cc)';
        btnEl.style.color = '#06060d';
    }
}
