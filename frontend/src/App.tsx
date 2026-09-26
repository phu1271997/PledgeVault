import React, { useState, useEffect } from 'react';
import { getGenLayerClient } from './lib/client';
import { connectWallet } from './lib/wallet';
import { PLEDGE_CONTRACT } from './lib/addresses';
import {
  Handshake,
  ShieldCheck,
  Lock,
  CheckCircle2,
  XCircle,
  Scale,
  ExternalLink,
  PlusCircle,
  RefreshCw,
  AlertTriangle,
  Wallet,
  Clock,
  Sparkles,
  ArrowRight,
  Target,
  Gavel,
} from 'lucide-react';

const EXPLORER = 'https://genlayer-explorer.vercel.app';

interface Pledge {
  pledge_id: string;
  maker: string;
  title: string;
  statement: string;
  verify_url: string;
  beneficiary: string;
  deadline_epoch: number;
  dispute_window_secs: number;
  stake: string;
  support_pool: string;
  state: string; // ACTIVE | DISPUTE | SETTLED
  verdict: string; // KEPT | BROKEN | PARTIAL | ''
  reason: string;
  confidence: number;
  resolve_deadline: number;
  rebuttal_url: string;
  created_at: number;
}

interface Stats {
  total_pledges: number;
  locked: string;
  kept: number;
  broken: number;
  fee_pool: string;
}

// ---------- helpers ----------
const toGen = (wei: string | number | undefined): string => {
  if (wei === undefined || wei === null || wei === '') return '0';
  try {
    return (Number(wei) / 1e18).toLocaleString(undefined, {
      maximumFractionDigits: 3,
    });
  } catch {
    return '0';
  }
};

const genToWei = (x: string | number): bigint =>
  BigInt(Math.floor(Number(x) * 1e18));

const short = (addr: string | undefined): string =>
  addr && addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr || '—';

const fmtDate = (epoch: number): string => {
  if (!epoch) return '—';
  try {
    return new Date(epoch * 1000).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const countdown = (target: number, now: number): string => {
  const diff = target - now;
  if (diff <= 0) return 'elapsed';
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

const stateBadge = (state: string): string => {
  switch (state) {
    case 'ACTIVE':
      return 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
    case 'DISPUTE':
      return 'bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse';
    case 'SETTLED':
      return 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20';
    default:
      return 'bg-gray-500/10 text-gray-400 border border-gray-500/20';
  }
};

const verdictStyle = (verdict: string) => {
  switch (verdict) {
    case 'KEPT':
      return { color: 'text-emerald-400', bg: 'bg-emerald-950/30 border-emerald-500/30', bar: 'bg-emerald-400', Icon: CheckCircle2 };
    case 'BROKEN':
      return { color: 'text-rose-400', bg: 'bg-rose-950/30 border-rose-500/30', bar: 'bg-rose-400', Icon: XCircle };
    case 'PARTIAL':
      return { color: 'text-amber-400', bg: 'bg-amber-950/30 border-amber-500/30', bar: 'bg-amber-400', Icon: Scale };
    default:
      return { color: 'text-gray-400', bg: 'bg-gray-900/40 border-gray-700/40', bar: 'bg-gray-400', Icon: Sparkles };
  }
};

export default function App() {
  const [account, setAccount] = useState<string | null>(null);
  const [balance, setBalance] = useState<string>('0');
  const [claimable, setClaimable] = useState<string>('0');
  const [activeTab, setActiveTab] = useState<'pledges' | 'detail' | 'about'>('pledges');

  const [stats, setStats] = useState<Stats | null>(null);
  const [pledges, setPledges] = useState<Pledge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Pledge | null>(null);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState('Submitting transaction...');
  const [consensus, setConsensus] = useState(false);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(Math.floor(Date.now() / 1000));

  const [stateFilter, setStateFilter] = useState('ALL');

  // create form
  const [showCreate, setShowCreate] = useState(false);
  const [cTitle, setCTitle] = useState('');
  const [cStatement, setCStatement] = useState('');
  const [cVerifyUrl, setCVerifyUrl] = useState('');
  const [cBeneficiary, setCBeneficiary] = useState('');
  const [cDeadline, setCDeadline] = useState('');
  const [cWindow, setCWindow] = useState('259200');
  const [cStake, setCStake] = useState('2');

  // back form
  const [backAmount, setBackAmount] = useState('1');

  // dispute form
  const [showDispute, setShowDispute] = useState(false);
  const [rebuttalUrl, setRebuttalUrl] = useState('');
  const [disputeBond, setDisputeBond] = useState('1');

  // clock tick for countdowns
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // ---------- wallet ----------
  const handleConnect = async () => {
    try {
      setLoading(true);
      setError(null);
      const addr = await connectWallet();
      setAccount(addr);
      fetchBalance(addr);
      fetchClaimable(addr);
    } catch (e: any) {
      setError(e.message || 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  const fetchBalance = async (addr: string) => {
    try {
      if (typeof window !== 'undefined' && window.ethereum) {
        const res: any = await window.ethereum.request({
          method: 'eth_getBalance',
          params: [addr, 'latest'],
        });
        if (res) setBalance((Number(BigInt(res)) / 1e18).toFixed(3));
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchClaimable = async (addr: string) => {
    try {
      const client = getGenLayerClient();
      const raw: any = await client.readContract({
        address: PLEDGE_CONTRACT,
        functionName: 'get_balance',
        args: [addr],
      });
      const val = typeof raw === 'string' ? raw.replace(/"/g, '') : raw;
      setClaimable(String(val ?? '0'));
    } catch (e) {
      console.error('claimable error', e);
    }
  };

  // ---------- reads ----------
  const fetchStats = async () => {
    try {
      const client = getGenLayerClient();
      const raw: any = await client.readContract({
        address: PLEDGE_CONTRACT,
        functionName: 'get_stats',
        args: [],
      });
      if (raw) setStats(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch (e) {
      console.error('stats error', e);
    }
  };

  const fetchPledges = async () => {
    try {
      setLoading(true);
      const client = getGenLayerClient();
      const raw: any = await client.readContract({
        address: PLEDGE_CONTRACT,
        functionName: 'list_pledges',
        args: ['ALL', 0, 100],
      });
      if (raw) {
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        setPledges(Array.isArray(list) ? list : []);
      }
    } catch (e) {
      console.error('list error', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchDetail = async (id: string) => {
    try {
      setLoading(true);
      const client = getGenLayerClient();
      const raw: any = await client.readContract({
        address: PLEDGE_CONTRACT,
        functionName: 'get_pledge',
        args: [id],
      });
      if (raw) setSelected(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch (e) {
      console.error('detail error', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    fetchPledges();
  }, []);

  useEffect(() => {
    if (activeTab === 'detail' && selectedId) fetchDetail(selectedId);
  }, [activeTab, selectedId]);

  const refreshAll = () => {
    fetchStats();
    fetchPledges();
    if (selectedId) fetchDetail(selectedId);
    if (account) {
      fetchBalance(account);
      fetchClaimable(account);
    }
  };

  // ---------- writes ----------
  const runTx = async (
    fn: () => Promise<any>,
    msg: string,
    isConsensus = false
  ): Promise<boolean> => {
    if (!account) {
      setError('Please connect your MetaMask wallet first.');
      return false;
    }
    try {
      setError(null);
      setBusy(true);
      setBusyMsg(msg);
      setConsensus(isConsensus);
      setLastTxHash(null);
      const client = getGenLayerClient(account as `0x${string}`);
      const tx = await fn();
      setLastTxHash(tx as string);
      await (client as any).waitForTransactionReceipt({ hash: tx as any });
      refreshAll();
      return true;
    } catch (e: any) {
      setError(e.message || String(e));
      return false;
    } finally {
      setBusy(false);
      setConsensus(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return setError('Please connect your MetaMask wallet first.');
    if (Number(cStake) < 2) return setError('Stake must be at least 2 GEN.');
    const deadlineEpoch = Math.floor(new Date(cDeadline).getTime() / 1000);
    if (!deadlineEpoch || deadlineEpoch <= nowSec)
      return setError('Deadline must be a valid date in the future.');

    const ok = await runTx(async () => {
      const client = getGenLayerClient(account as `0x${string}`);
      const stakeWei = genToWei(cStake);
      return client.writeContract({
        address: PLEDGE_CONTRACT,
        functionName: 'create_pledge',
        args: [
          cTitle,
          cStatement,
          cVerifyUrl,
          cBeneficiary as `0x${string}`,
          deadlineEpoch,
          Number(cWindow),
        ],
        value: stakeWei,
      });
    }, 'Creating pledge and locking accountability bond...');

    if (ok) {
      setShowCreate(false);
      setCTitle('');
      setCStatement('');
      setCVerifyUrl('');
      setCBeneficiary('');
      setCDeadline('');
      setCStake('2');
    }
  };

  const handleBack = async (id: string) => {
    if (Number(backAmount) <= 0) return setError('Enter a reward contribution greater than 0.');
    await runTx(async () => {
      const client = getGenLayerClient(account as `0x${string}`);
      return client.writeContract({
        address: PLEDGE_CONTRACT,
        functionName: 'back_pledge',
        args: [id],
        value: genToWei(backAmount),
      });
    }, 'Backing pledge and adding to the reward pool...');
  };

  const handleResolve = async (id: string) => {
    await runTx(
      async () => {
        const client = getGenLayerClient(account as `0x${string}`);
        return client.writeContract({
          address: PLEDGE_CONTRACT,
          functionName: 'resolve',
          args: [id],
          value: BigInt(0),
        });
      },
      'AI validators reaching consensus — can take a minute...',
      true
    );
  };

  const handleDispute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    if (Number(disputeBond) < 1) return setError('Dispute bond must be at least 1 GEN.');
    const ok = await runTx(async () => {
      const client = getGenLayerClient(account as `0x${string}`);
      return client.writeContract({
        address: PLEDGE_CONTRACT,
        functionName: 'dispute',
        args: [selected.pledge_id, rebuttalUrl],
        value: genToWei(disputeBond),
      });
    }, 'Filing dispute and locking rebuttal bond...');
    if (ok) {
      setShowDispute(false);
      setRebuttalUrl('');
      setDisputeBond('1');
    }
  };

  const handleFinalize = async (id: string) => {
    await runTx(async () => {
      const client = getGenLayerClient(account as `0x${string}`);
      return client.writeContract({
        address: PLEDGE_CONTRACT,
        functionName: 'finalize',
        args: [id],
        value: BigInt(0),
      });
    }, 'Finalizing pledge and routing funds per verdict...');
  };

  const handleWithdraw = async () => {
    await runTx(async () => {
      const client = getGenLayerClient(account as `0x${string}`);
      return client.writeContract({
        address: PLEDGE_CONTRACT,
        functionName: 'withdraw',
        args: [],
        value: BigInt(0),
      });
    }, 'Withdrawing your claimable balance...');
  };

  const filtered =
    stateFilter === 'ALL' ? pledges : pledges.filter((p) => p.state === stateFilter);

  // ---------- render ----------
  return (
    <div className="min-h-screen flex flex-col bg-[#070B14] text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-[#0B0F19]/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div
            className="flex items-center space-x-3 cursor-pointer"
            onClick={() => setActiveTab('pledges')}
          >
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-indigo-600 flex items-center justify-center text-xl shadow-lg shadow-emerald-500/20">
              🤝
            </div>
            <div>
              <div className="font-bold text-lg tracking-tight bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent">
                PledgeVault
              </div>
              <div className="hidden sm:block text-[10px] text-emerald-400 font-medium tracking-wide">
                Autonomous Kept-Promise Accountability Bond on GenLayer
              </div>
            </div>
          </div>

          <nav className="hidden md:flex items-center space-x-1 text-sm font-medium">
            <button
              onClick={() => setActiveTab('pledges')}
              className={`px-3 py-1.5 rounded-lg transition ${
                activeTab === 'pledges' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              Pledges
            </button>
            <button
              onClick={() => setActiveTab('about')}
              className={`px-3 py-1.5 rounded-lg transition ${
                activeTab === 'about' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              How It Works
            </button>
            <a
              href={`${EXPLORER}/address/${PLEDGE_CONTRACT}`}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 rounded-lg text-gray-400 hover:text-white transition flex items-center space-x-1"
            >
              <span>Contract</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </nav>

          <div className="flex items-center space-x-3">
            {account ? (
              <div className="flex items-center space-x-2 bg-gray-900 border border-gray-800 px-3 py-1.5 rounded-xl text-xs">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                <span className="font-mono text-gray-300">{short(account)}</span>
                <span className="text-emerald-400 font-semibold pl-1 border-l border-gray-700">
                  {balance} GEN
                </span>
              </div>
            ) : (
              <button
                onClick={handleConnect}
                disabled={loading}
                className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-xs font-semibold px-4 py-2 rounded-xl transition shadow-lg shadow-emerald-600/20 flex items-center space-x-1.5"
              >
                <Wallet className="w-4 h-4" />
                <span>{loading ? 'Connecting...' : 'Connect Wallet'}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Low balance banner */}
      {account && Number(balance) === 0 && (
        <div className="bg-amber-950/40 border-b border-amber-800/60 px-4 py-2 text-xs text-amber-200 flex items-center justify-center space-x-2 text-center">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <span>
            Connected wallet has 0 GEN on studionet. Open{' '}
            <a
              href="https://studio.genlayer.com"
              target="_blank"
              rel="noreferrer"
              className="underline font-bold text-amber-300 hover:text-white"
            >
              GenLayer Studio → Accounts panel
            </a>{' '}
            to transfer test GEN.
          </span>
        </div>
      )}

      {/* Busy overlay */}
      {busy && (
        <div
          className={`${
            consensus ? 'bg-indigo-950/80 border-indigo-700/60 text-indigo-100' : 'bg-gray-900/90 border-gray-700/60 text-gray-200'
          } border-b px-4 py-3 text-xs flex items-center justify-center space-x-3`}
        >
          <RefreshCw className={`w-4 h-4 ${consensus ? 'text-indigo-400' : 'text-emerald-400'} animate-spin`} />
          <div className="text-center">
            <span className={`font-bold ${consensus ? 'text-indigo-300' : 'text-emerald-300'}`}>{busyMsg}</span>
            {consensus && (
              <span className="ml-1">Diverse LLM validators independently read the evidence and reach on-chain consensus.</span>
            )}
            {lastTxHash && (
              <a
                href={`${EXPLORER}/tx/${lastTxHash}`}
                target="_blank"
                rel="noreferrer"
                className="ml-2 underline text-emerald-300 hover:text-white inline-flex items-center"
              >
                View tx <ExternalLink className="w-3 h-3 ml-1" />
              </a>
            )}
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="bg-rose-950/50 border-b border-rose-800/60 px-4 py-2.5 text-xs text-rose-200 flex items-center justify-center space-x-2">
          <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
          <span className="break-all">{error}</span>
          <button onClick={() => setError(null)} className="ml-2 underline text-rose-300 hover:text-white">
            dismiss
          </button>
        </div>
      )}

      {/* Consensus loading overlay (full screen) */}
      {consensus && busy && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-indigo-800/60 rounded-3xl p-8 max-w-md text-center space-y-4">
            <div className="w-16 h-16 mx-auto rounded-full bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center">
              <Sparkles className="w-8 h-8 text-indigo-400 animate-pulse" />
            </div>
            <h3 className="text-lg font-bold text-white">AI validators reaching consensus</h3>
            <p className="text-sm text-gray-400">
              This can take a minute. Diverse LLM validators fetch the verification evidence, judge whether the promise
              was kept, and reach semantic consensus on-chain. Please keep this window open.
            </p>
            <div className="flex items-center justify-center space-x-2 text-indigo-400">
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span className="text-xs font-semibold">Verifying...</span>
            </div>
          </div>
        </div>
      )}

      {/* Main */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* ---------- PLEDGES (dashboard + list) ---------- */}
        {activeTab === 'pledges' && (
          <div className="space-y-8">
            {/* Hero */}
            <div>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                On-Chain Accountability Bonds
              </h1>
              <p className="text-sm text-gray-400 mt-1 max-w-3xl">
                Makers lock a GEN stake behind a public promise with a verifiable evidence URL. After the deadline, an
                AI validator jury reads the evidence directly on-chain and rules whether the promise was{' '}
                <span className="text-emerald-400 font-semibold">KEPT</span> or{' '}
                <span className="text-rose-400 font-semibold">BROKEN</span> — routing the bond accordingly.
              </p>
            </div>

            {/* Stat cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                icon={<Target className="w-5 h-5 text-indigo-400" />}
                label="Total Pledges"
                value={stats ? String(stats.total_pledges) : '—'}
                accent="text-white"
              />
              <StatCard
                icon={<Lock className="w-5 h-5 text-emerald-400" />}
                label="GEN Locked"
                value={stats ? `${toGen(stats.locked)}` : '—'}
                accent="text-emerald-400"
              />
              <StatCard
                icon={<CheckCircle2 className="w-5 h-5 text-emerald-400" />}
                label="Promises Kept"
                value={stats ? String(stats.kept) : '—'}
                accent="text-emerald-400"
              />
              <StatCard
                icon={<XCircle className="w-5 h-5 text-rose-400" />}
                label="Promises Broken"
                value={stats ? String(stats.broken) : '—'}
                accent="text-rose-400"
              />
            </div>

            {/* Withdraw bar */}
            {account && (
              <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                    <Wallet className="w-5 h-5 text-emerald-400" />
                  </div>
                  <div>
                    <div className="text-xs text-gray-400">Your claimable balance (pull payout)</div>
                    <div className="text-lg font-bold text-emerald-400">{toGen(claimable)} GEN</div>
                  </div>
                </div>
                <button
                  onClick={handleWithdraw}
                  disabled={busy || Number(claimable) <= 0}
                  className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold px-5 py-2.5 rounded-xl transition"
                >
                  Withdraw
                </button>
              </div>
            )}

            {/* Toolbar */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-center bg-gray-900 border border-gray-800 rounded-xl p-1 text-xs overflow-x-auto">
                {['ALL', 'ACTIVE', 'DISPUTE', 'SETTLED'].map((f) => (
                  <button
                    key={f}
                    onClick={() => setStateFilter(f)}
                    className={`px-3 py-1.5 rounded-lg font-medium transition whitespace-nowrap ${
                      stateFilter === f ? 'bg-emerald-600 text-white' : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={refreshAll}
                  className="bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-semibold px-4 py-2.5 rounded-xl transition flex items-center space-x-2"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Refresh</span>
                </button>
                <button
                  onClick={() => {
                    setError(null);
                    setShowCreate(true);
                  }}
                  className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-semibold px-4 py-2.5 rounded-xl transition flex items-center space-x-2 shadow-lg shadow-emerald-600/20"
                >
                  <PlusCircle className="w-4 h-4" />
                  <span>Create Pledge</span>
                </button>
              </div>
            </div>

            {/* Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filtered.map((p) => (
                <div
                  key={p.pledge_id}
                  onClick={() => {
                    setSelectedId(p.pledge_id);
                    setActiveTab('detail');
                  }}
                  className="bg-gray-900/60 border border-gray-800 hover:border-emerald-500/50 rounded-2xl p-5 transition cursor-pointer flex flex-col justify-between group hover:shadow-xl hover:shadow-emerald-500/5"
                >
                  <div>
                    <div className="flex items-center justify-between mb-3 text-xs">
                      <span className="font-mono text-gray-400">Pledge #{p.pledge_id}</span>
                      <span className={`px-2.5 py-0.5 rounded-full font-semibold text-[10px] ${stateBadge(p.state)}`}>
                        {p.state}
                      </span>
                    </div>
                    <h3 className="text-base font-bold text-gray-100 group-hover:text-emerald-400 transition leading-snug line-clamp-2 mb-2">
                      {p.title}
                    </h3>
                    <p className="text-xs text-gray-400 line-clamp-3 mb-4">{p.statement}</p>
                    <div className="text-[11px] text-gray-500 mb-4">
                      by <span className="font-mono text-gray-400">{short(p.maker)}</span>
                    </div>
                  </div>

                  <div className="border-t border-gray-800/80 pt-4 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-400 flex items-center space-x-1">
                        <Lock className="w-3.5 h-3.5" /> <span>Stake</span>
                      </span>
                      <span className="font-semibold text-emerald-400">{toGen(p.stake)} GEN</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-400 flex items-center space-x-1">
                        <Handshake className="w-3.5 h-3.5" /> <span>Reward pool</span>
                      </span>
                      <span className="font-medium text-gray-300">{toGen(p.support_pool)} GEN</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-400 flex items-center space-x-1">
                        <Clock className="w-3.5 h-3.5" /> <span>Deadline</span>
                      </span>
                      <span className="font-medium text-gray-300">{fmtDate(p.deadline_epoch)}</span>
                    </div>

                    {p.verify_url && (
                      <a
                        href={p.verify_url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="mt-1 inline-flex items-center space-x-1 text-[11px] text-indigo-400 hover:text-indigo-300"
                      >
                        <ExternalLink className="w-3 h-3" />
                        <span className="underline">{hostOf(p.verify_url)}</span>
                      </a>
                    )}

                    {p.verdict && (
                      <div className="mt-2 pt-2 border-t border-gray-800/60 flex items-center justify-between text-xs">
                        <span className="text-gray-400">Verdict</span>
                        <span className={`font-bold ${verdictStyle(p.verdict).color}`}>
                          {p.verdict} {p.confidence ? `(${p.confidence}%)` : ''}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {filtered.length === 0 && (
              <div className="text-center py-16 bg-gray-900/30 rounded-2xl border border-gray-800/60">
                <Handshake className="w-12 h-12 mx-auto text-gray-600 mb-3" />
                <h3 className="text-base font-semibold text-gray-300">
                  {loading ? 'Loading pledges...' : 'No pledges in this category yet'}
                </h3>
                <p className="text-xs text-gray-500 mt-1">Be the first to put a bond behind your word.</p>
              </div>
            )}
          </div>
        )}

        {/* ---------- DETAIL ---------- */}
        {activeTab === 'detail' && selected && (
          <PledgeDetail
            p={selected}
            account={account}
            nowSec={nowSec}
            busy={busy}
            backAmount={backAmount}
            setBackAmount={setBackAmount}
            onBack={() => setActiveTab('pledges')}
            onBackPledge={() => handleBack(selected.pledge_id)}
            onResolve={() => handleResolve(selected.pledge_id)}
            onFinalize={() => handleFinalize(selected.pledge_id)}
            onOpenDispute={() => {
              setError(null);
              setShowDispute(true);
            }}
          />
        )}
        {activeTab === 'detail' && !selected && (
          <div className="text-center py-16 text-gray-400">
            <RefreshCw className="w-8 h-8 mx-auto animate-spin mb-3 text-gray-600" />
            Loading pledge...
          </div>
        )}

        {/* ---------- ABOUT ---------- */}
        {activeTab === 'about' && <About />}
      </main>

      {/* CREATE MODAL */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-gray-900 border border-gray-800 rounded-3xl max-w-lg w-full p-6 sm:p-8 space-y-5 my-8">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-white flex items-center space-x-2">
                <Handshake className="w-5 h-5 text-emerald-400" />
                <span>Create Accountability Pledge</span>
              </h3>
              <button onClick={() => setShowCreate(false)} className="text-gray-400 hover:text-white text-lg">
                ×
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-4">
              <Field label="Title">
                <input
                  type="text"
                  value={cTitle}
                  onChange={(e) => setCTitle(e.target.value)}
                  placeholder="e.g. I will ship the open-source release by Q4"
                  className={inputCls}
                  required
                />
              </Field>

              <Field label="Statement (the promise, in detail)">
                <textarea
                  rows={3}
                  value={cStatement}
                  onChange={(e) => setCStatement(e.target.value)}
                  placeholder="Describe exactly what will be true by the deadline, and how it can be verified."
                  className={inputCls}
                  required
                />
              </Field>

              <Field label="Verification URL (HTTPS — validators will read this)">
                <input
                  type="url"
                  value={cVerifyUrl}
                  onChange={(e) => setCVerifyUrl(e.target.value)}
                  placeholder="https://github.com/you/project/releases"
                  className={inputCls}
                  required
                />
              </Field>

              <Field label="Beneficiary address (receives bond if BROKEN)">
                <input
                  type="text"
                  value={cBeneficiary}
                  onChange={(e) => setCBeneficiary(e.target.value)}
                  placeholder="0x..."
                  className={`${inputCls} font-mono`}
                  required
                />
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field label="Deadline">
                  <input
                    type="datetime-local"
                    value={cDeadline}
                    onChange={(e) => setCDeadline(e.target.value)}
                    className={inputCls}
                    required
                  />
                </Field>
                <Field label="Dispute window">
                  <select value={cWindow} onChange={(e) => setCWindow(e.target.value)} className={inputCls}>
                    <option value="86400">1 day</option>
                    <option value="172800">2 days</option>
                    <option value="259200">3 days</option>
                    <option value="604800">7 days</option>
                  </select>
                </Field>
              </div>

              <Field label="Stake / accountability bond (min 2 GEN)">
                <input
                  type="number"
                  step="0.1"
                  min="2"
                  value={cStake}
                  onChange={(e) => setCStake(e.target.value)}
                  className={inputCls}
                  required
                />
              </Field>

              <div className="pt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-white text-xs font-semibold py-3 rounded-xl transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-xs font-bold py-3 rounded-xl transition shadow-lg shadow-emerald-600/20"
                >
                  {busy ? 'Locking bond...' : `Lock ${cStake || '0'} GEN & Publish`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DISPUTE MODAL */}
      {showDispute && selected && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-gray-900 border border-gray-800 rounded-3xl max-w-lg w-full p-6 sm:p-8 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-white flex items-center space-x-2">
                <Gavel className="w-5 h-5 text-amber-400" />
                <span>Dispute Verdict</span>
              </h3>
              <button onClick={() => setShowDispute(false)} className="text-gray-400 hover:text-white text-lg">
                ×
              </button>
            </div>
            <div className="bg-amber-950/30 border border-amber-800/40 rounded-xl p-3 text-xs text-amber-200">
              Post a rebuttal with contradicting evidence and a bond (min 1 GEN). If the dispute stands after the window
              elapses, funds route accordingly on finalize.
            </div>
            <form onSubmit={handleDispute} className="space-y-4">
              <Field label="Rebuttal / counter-evidence URL (HTTPS)">
                <input
                  type="url"
                  value={rebuttalUrl}
                  onChange={(e) => setRebuttalUrl(e.target.value)}
                  placeholder="https://..."
                  className={inputCls}
                  required
                />
              </Field>
              <Field label="Dispute bond (min 1 GEN)">
                <input
                  type="number"
                  step="0.1"
                  min="1"
                  value={disputeBond}
                  onChange={(e) => setDisputeBond(e.target.value)}
                  className={inputCls}
                  required
                />
              </Field>
              <div className="pt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowDispute(false)}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-white text-xs font-semibold py-3 rounded-xl transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="flex-1 bg-amber-600 hover:bg-amber-500 disabled:opacity-60 text-white text-xs font-bold py-3 rounded-xl transition shadow-lg shadow-amber-600/20"
                >
                  {busy ? 'Filing...' : `Deposit ${disputeBond || '0'} GEN & Dispute`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-gray-800 py-6 text-center text-xs text-gray-500">
        PledgeVault · GenLayer Studionet ·{' '}
        <a
          href={`${EXPLORER}/address/${PLEDGE_CONTRACT}`}
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-gray-300 font-mono"
        >
          {short(PLEDGE_CONTRACT)}
        </a>
      </footer>
    </div>
  );
}

// ---------- subcomponents ----------
const inputCls =
  'w-full bg-gray-950 border border-gray-800 rounded-xl p-3 text-sm text-gray-100 focus:outline-none focus:border-emerald-500';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-300 mb-1">{label}</label>
      {children}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-5">
      <div className="flex items-center space-x-2 text-xs text-gray-400 mb-2">
        {icon}
        <span className="uppercase tracking-wider">{label}</span>
      </div>
      <div className={`text-2xl sm:text-3xl font-black ${accent}`}>{value}</div>
    </div>
  );
}

function PledgeDetail({
  p,
  account,
  nowSec,
  busy,
  backAmount,
  setBackAmount,
  onBack,
  onBackPledge,
  onResolve,
  onFinalize,
  onOpenDispute,
}: {
  p: Pledge;
  account: string | null;
  nowSec: number;
  busy: boolean;
  backAmount: string;
  setBackAmount: (v: string) => void;
  onBack: () => void;
  onBackPledge: () => void;
  onResolve: () => void;
  onFinalize: () => void;
  onOpenDispute: () => void;
}) {
  const vs = verdictStyle(p.verdict);
  const deadlinePassed = nowSec >= p.deadline_epoch;
  const windowElapsed = p.resolve_deadline > 0 && nowSec >= p.resolve_deadline;
  const isMaker = account && account.toLowerCase() === p.maker?.toLowerCase();

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="text-xs text-gray-400 hover:text-white flex items-center space-x-1 transition">
        <span>← Back to all pledges</span>
      </button>

      {/* Header card */}
      <div className="bg-gray-900 border border-gray-800 rounded-3xl p-6 sm:p-8">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6">
          <div className="max-w-3xl">
            <div className="flex items-center space-x-3 text-xs mb-3">
              <span className="font-mono text-gray-400">Pledge #{p.pledge_id}</span>
              <span className={`px-3 py-1 rounded-full font-semibold ${stateBadge(p.state)}`}>{p.state}</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white leading-tight mb-3">{p.title}</h1>
            <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap mb-4">{p.statement}</p>

            <div className="flex flex-wrap gap-2 text-xs">
              {p.verify_url && (
                <a
                  href={p.verify_url}
                  target="_blank"
                  rel="noreferrer"
                  className="bg-gray-800 hover:bg-gray-700 px-2.5 py-1 rounded-md text-indigo-400 flex items-center space-x-1 transition"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span className="underline">{hostOf(p.verify_url)}</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
              {p.rebuttal_url && (
                <a
                  href={p.rebuttal_url}
                  target="_blank"
                  rel="noreferrer"
                  className="bg-gray-800 hover:bg-gray-700 px-2.5 py-1 rounded-md text-amber-400 flex items-center space-x-1 transition"
                >
                  <Gavel className="w-3.5 h-3.5" />
                  <span className="underline">Rebuttal: {hostOf(p.rebuttal_url)}</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          </div>

          {/* Info box */}
          <div className="bg-gray-950/80 border border-gray-800 rounded-2xl p-5 min-w-[280px] space-y-3 text-xs">
            <div>
              <div className="text-gray-400 mb-1">Accountability bond (stake)</div>
              <div className="text-2xl font-extrabold text-emerald-400">{toGen(p.stake)} GEN</div>
            </div>
            <div className="flex items-center justify-between border-t border-gray-800 pt-3">
              <span className="text-gray-400">Reward pool</span>
              <span className="font-semibold text-gray-200">{toGen(p.support_pool)} GEN</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-400">Maker</span>
              <span className="font-mono text-gray-200">{short(p.maker)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-400">Beneficiary</span>
              <span className="font-mono text-gray-200">{short(p.beneficiary)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-400">Deadline</span>
              <span className="text-gray-200">{fmtDate(p.deadline_epoch)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-400">Dispute window</span>
              <span className="text-gray-200">{Math.round(p.dispute_window_secs / 86400)}d</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-400">Created</span>
              <span className="text-gray-200">{fmtDate(p.created_at)}</span>
            </div>
          </div>
        </div>

        {/* VERDICT */}
        {p.verdict && (
          <div className={`mt-8 pt-6 border-t border-gray-800/80`}>
            <div className={`rounded-2xl border p-6 ${vs.bg}`}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <div className="flex items-center space-x-3">
                  <vs.Icon className={`w-8 h-8 ${vs.color}`} />
                  <div>
                    <div className="text-xs text-gray-400 uppercase tracking-wider">AI Consensus Verdict</div>
                    <div className={`text-3xl font-black ${vs.color}`}>{p.verdict}</div>
                  </div>
                </div>
                <div className="flex items-center space-x-2 text-xs">
                  <span className="text-gray-400">Confidence</span>
                  <div className="w-28 bg-gray-800 rounded-full h-2 overflow-hidden">
                    <div className={`${vs.bar} h-full rounded-full`} style={{ width: `${p.confidence || 0}%` }}></div>
                  </div>
                  <span className={`font-bold ${vs.color}`}>{p.confidence || 0}%</span>
                </div>
              </div>
              {p.reason && (
                <div className="bg-gray-950/50 rounded-xl p-4 border border-gray-800/60">
                  <div className="text-xs text-gray-400 uppercase tracking-wider mb-1 flex items-center space-x-1">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Validator Reasoning</span>
                  </div>
                  <p className="text-sm text-gray-200 leading-relaxed italic">"{p.reason}"</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Actions by state */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-5">
        <h2 className="text-base font-bold text-white flex items-center space-x-2">
          <Target className="w-5 h-5 text-emerald-400" />
          <span>Actions</span>
        </h2>

        {!account && <p className="text-xs text-gray-400">Connect your wallet to interact with this pledge.</p>}

        {/* ACTIVE */}
        {p.state === 'ACTIVE' && (
          <div className="space-y-4">
            {!deadlinePassed ? (
              <div className="space-y-3">
                <p className="text-xs text-gray-400">
                  Back this pledge to grow the reward the maker earns for keeping their word.
                </p>
                <div className="flex flex-col sm:flex-row gap-3">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={backAmount}
                    onChange={(e) => setBackAmount(e.target.value)}
                    className={`${inputCls} sm:max-w-xs`}
                    placeholder="Amount in GEN"
                  />
                  <button
                    onClick={onBackPledge}
                    disabled={busy || !account}
                    className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold px-6 py-3 rounded-xl transition flex items-center justify-center space-x-2"
                  >
                    <Handshake className="w-4 h-4" />
                    <span>Back this pledge</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-indigo-950/30 border border-indigo-800/40 rounded-xl p-3 text-xs text-indigo-200">
                  Deadline has passed. Anyone can now trigger the AI validator jury to read the evidence and rule on
                  whether the promise was kept.
                </div>
                <button
                  onClick={onResolve}
                  disabled={busy || !account}
                  className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-40 text-white text-xs font-bold px-6 py-3 rounded-xl transition flex items-center space-x-2 shadow-lg shadow-indigo-600/20"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>Resolve with AI</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* DISPUTE */}
        {p.state === 'DISPUTE' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between bg-amber-950/30 border border-amber-800/40 rounded-xl p-3 text-xs text-amber-200">
              <span className="flex items-center space-x-2">
                <Clock className="w-4 h-4" />
                <span>
                  Dispute window {windowElapsed ? 'has elapsed' : 'closes in'}{' '}
                  {!windowElapsed && <span className="font-bold">{countdown(p.resolve_deadline, nowSec)}</span>}
                </span>
              </span>
              <span className="text-gray-400">{fmtDate(p.resolve_deadline)}</span>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              {!windowElapsed && (
                <button
                  onClick={onOpenDispute}
                  disabled={busy || !account}
                  className="bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-xs font-bold px-6 py-3 rounded-xl transition flex items-center space-x-2"
                >
                  <Gavel className="w-4 h-4" />
                  <span>Dispute (1 GEN bond)</span>
                </button>
              )}
              {windowElapsed && (
                <button
                  onClick={onFinalize}
                  disabled={busy || !account}
                  className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold px-6 py-3 rounded-xl transition flex items-center space-x-2"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Finalize & route funds</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* SETTLED */}
        {p.state === 'SETTLED' && (
          <div className="space-y-3">
            <div className={`rounded-xl border p-4 ${vs.bg}`}>
              <div className="flex items-center space-x-2 mb-2">
                <vs.Icon className={`w-5 h-5 ${vs.color}`} />
                <span className={`font-bold ${vs.color}`}>Settled — {p.verdict || 'resolved'}</span>
              </div>
              <p className="text-xs text-gray-300">
                {p.verdict === 'KEPT' && (
                  <>
                    The promise was kept. The accountability bond and reward pool were returned/routed to the maker (
                    <span className="font-mono">{short(p.maker)}</span>).
                  </>
                )}
                {p.verdict === 'BROKEN' && (
                  <>
                    The promise was broken. The bond was routed to the beneficiary (
                    <span className="font-mono">{short(p.beneficiary)}</span>).
                  </>
                )}
                {p.verdict === 'PARTIAL' && (
                  <>Partially kept. Funds were split between the maker and beneficiary per the contract's rules.</>
                )}
                {!p.verdict && <>This pledge has been settled.</>}
              </p>
              <p className="text-[11px] text-gray-500 mt-2">
                Payouts use a pull pattern — recipients withdraw their balance from the Pledges tab.
              </p>
            </div>
          </div>
        )}

        {isMaker && (
          <p className="text-[11px] text-gray-500 border-t border-gray-800 pt-3">You are the maker of this pledge.</p>
        )}
      </div>
    </div>
  );
}

function About() {
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-extrabold text-white tracking-tight">How PledgeVault Works</h1>
      <div className="text-sm text-gray-300 space-y-4">
        <p>
          PledgeVault turns a promise into an enforceable, value-bearing bond. A maker locks a GEN stake behind a public
          statement and supplies a verification URL. When the deadline passes, GenLayer's AI validators read that
          evidence directly on-chain — no oracle — and reach consensus on whether the promise was{' '}
          <span className="text-emerald-400 font-semibold">KEPT</span>,{' '}
          <span className="text-rose-400 font-semibold">BROKEN</span>, or{' '}
          <span className="text-amber-400 font-semibold">PARTIAL</span>.
        </p>
        <div className="grid gap-3">
          <Step n={1} title="Create a pledge" text="Lock a bond (min 2 GEN), write your promise, set a deadline and a verification URL, and name a beneficiary who receives the bond if you fail." />
          <Step n={2} title="Community backs it" text="Anyone can add GEN to the reward pool, sweetening the payout the maker earns for following through." />
          <Step n={3} title="Resolve with AI" text="After the deadline, the resolve() call triggers a jury of diverse LLM validators that fetch the evidence and rule with a confidence score and written reasoning." />
          <Step n={4} title="Dispute window" text="During the dispute window anyone can post contradicting evidence with a bond. Otherwise the verdict stands." />
          <Step n={5} title="Finalize & withdraw" text="After the window elapses, finalize() routes funds per the verdict. Recipients pull their balance with withdraw()." />
        </div>
        <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-5">
          <h3 className="text-base font-bold text-white mb-2 flex items-center space-x-2">
            <Sparkles className="w-4 h-4 text-indigo-400" />
            <span>Why GenLayer is essential</span>
          </h3>
          <ul className="list-disc pl-5 space-y-2 text-gray-300">
            <li>Intelligent Contracts fetch and read live web evidence on-chain without external oracles.</li>
            <li>A jury of LLM validators reaches semantic consensus on a subjective question — "was the promise kept?"</li>
            <li>The verdict, confidence, and reasoning are recorded on-chain and drive automatic fund routing.</li>
          </ul>
        </div>
        <a
          href={`${EXPLORER}/address/${PLEDGE_CONTRACT}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center space-x-1 text-indigo-400 hover:text-indigo-300 text-sm"
        >
          <span>View the deployed contract on the explorer</span>
          <ArrowRight className="w-4 h-4" />
        </a>
      </div>
    </div>
  );
}

function Step({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <div className="flex items-start space-x-3 bg-gray-900/40 border border-gray-800/60 rounded-xl p-4">
      <div className="w-7 h-7 shrink-0 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center text-xs font-bold">
        {n}
      </div>
      <div>
        <div className="font-semibold text-white text-sm">{title}</div>
        <p className="text-xs text-gray-400 mt-0.5">{text}</p>
      </div>
    </div>
  );
}
