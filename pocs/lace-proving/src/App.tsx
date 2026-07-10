import { useCallback, useEffect, useState } from "react";
import type { ConnectedAPI, Configuration } from "@midnight-ntwrk/dapp-connector-api";
import { LogPanel } from "@/components/LogPanel";
import { StepCard, KeyVal, type StepStatus } from "@/components/StepCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DEFAULT_NETWORK, NETWORKS, type ProvingMode } from "@/config";
import { log } from "@/lib/logger";
import {
  connect as connectWallet,
  discoverWallets,
  pickWallet,
  type ConnectResult,
  type DiscoveredWallet,
} from "@/midnight/connector";
import {
  buildProviders,
  deployCounter,
  incrementCounter,
  readCounterRound,
  type CounterProviders,
  type DeployedCounter,
} from "@/midnight/providers";

interface TxInfo {
  txHash: string;
  blockHeight: number;
  status: string;
  contractAddress?: string;
}

export default function App() {
  const [network, setNetwork] = useState<string>(DEFAULT_NETWORK);
  const [mode, setMode] = useState<ProvingMode>("wallet");

  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [connected, setConnected] = useState<ConnectResult | null>(null);
  const [walletConfig, setWalletConfig] = useState<Configuration | null>(null);
  const [addresses, setAddresses] = useState<{ shielded: string; unshielded: string } | null>(null);

  const [providers, setProviders] = useState<CounterProviders | null>(null);
  const [deployed, setDeployed] = useState<DeployedCounter | null>(null);
  const [deployTx, setDeployTx] = useState<TxInfo | null>(null);
  const [incTx, setIncTx] = useState<TxInfo | null>(null);
  const [round, setRound] = useState<bigint | null | undefined>(undefined);

  const [st, setSt] = useState<Record<"connect" | "deploy" | "prove" | "results", StepStatus>>({
    connect: "idle",
    deploy: "idle",
    prove: "idle",
    results: "idle",
  });
  const setStatus = (k: keyof typeof st, v: StepStatus) => setSt((p) => ({ ...p, [k]: v }));

  // Auto-detect injected wallets on mount (non-destructive; connect is manual).
  useEffect(() => {
    setWallets(discoverWallets());
  }, []);

  const effNetwork = walletConfig?.networkId ?? network;

  const handleConnect = useCallback(async () => {
    setStatus("connect", "running");
    try {
      const found = discoverWallets();
      setWallets(found);
      const chosen = pickWallet(found);
      if (!chosen) throw new Error("No Midnight wallet injected under window.midnight.");

      const result = await connectWallet(chosen, network);
      setConnected(result);
      const api = result.api as ConnectedAPI;

      const cfg = await api.getConfiguration();
      setWalletConfig(cfg);
      log.info("app", "wallet.getConfiguration()", cfg);
      if (cfg.proverServerUri) {
        log.warn(
          "app",
          `wallet reports a (deprecated) proverServerUri = ${cfg.proverServerUri}. ` +
            "In-wallet proving should NOT require it.",
        );
      } else {
        log.success("app", "wallet reports NO proverServerUri (consistent with in-wallet proving).");
      }

      const shielded = await api.getShieldedAddresses();
      const unshielded = await api.getUnshieldedAddress();
      setAddresses({ shielded: shielded.shieldedAddress, unshielded: unshielded.unshieldedAddress });

      // Balances are useful context (a deploy needs DUST for fees).
      try {
        const dust = await api.getDustBalance();
        const unsh = await api.getUnshieldedBalances();
        log.info("app", "balances", { dust, unshielded: unsh });
      } catch (e) {
        log.warn("app", "could not read balances", e);
      }

      setStatus("connect", "done");
    } catch (err) {
      // DAppConnectorAPIError carries code + reason beyond name/message/stack.
      const apiErr = err as Partial<{ type: string; code: string; reason: string; message: string }>;
      if (apiErr?.type === "DAppConnectorAPIError" || apiErr?.code || apiErr?.reason) {
        log.error(
          "app",
          `connect step failed [code=${apiErr.code ?? "?"}] reason=${apiErr.reason ?? "?"}`,
          err,
        );
      } else {
        log.error("app", "connect step failed", err);
      }
      if (/wallet is unavailable/i.test(apiErr?.message ?? "")) {
        // Lace throws this from ensureWallet() when its Midnight wallet store
        // (midnightWallets$) is empty for the CURRENTLY SELECTED network in
        // Lace — authorization succeeds without a wallet instance, but
        // getConfiguration() needs one. (input-output-hk/lace:
        // dapp-connector-midnight/.../midnight-dapp-connector-api.ts)
        log.warn(
          "app",
          "Lace's Midnight wallet store is empty for its current network. Check, in order: " +
            "(1) click Connect again — a freshly-woken extension may not have started its account watch yet; " +
            "(2) open Lace and confirm the Midnight side is on Pre-prod with an account visible and synced; " +
            "(3) inspect the Lace service-worker console (chrome://extensions → Lace → service worker) for " +
            "'Account watch failure:' — wallet start errors (e.g. indexer unreachable) are swallowed there " +
            "and leave the store empty.",
        );
      }
      setStatus("connect", "error");
    }
  }, [network]);

  const handleDeploy = useCallback(async () => {
    if (!connected) return;
    setStatus("deploy", "running");
    try {
      const api = connected.api as ConnectedAPI;
      const cfg = walletConfig;
      const net = NETWORKS[effNetwork] ?? NETWORKS[DEFAULT_NETWORK];
      const built = await buildProviders({
        mode,
        api,
        networkId: effNetwork,
        indexerUri: cfg?.indexerUri ?? net.indexerUri,
        indexerWsUri: cfg?.indexerWsUri ?? net.indexerWsUri,
        proofServerUri: cfg?.proverServerUri ?? net.proofServerUri,
        accountId: addresses?.unshielded ?? "poc-account",
      });
      setProviders(built);

      const d = await deployCounter(built);
      setDeployed(d);
      const info: TxInfo = {
        txHash: d.deployTxData.public.txHash,
        blockHeight: d.deployTxData.public.blockHeight,
        status: String(d.deployTxData.public.status),
        contractAddress: d.deployTxData.public.contractAddress,
      };
      setDeployTx(info);
      log.success("app", `counter deployed at ${info.contractAddress}`);
      setStatus("deploy", "done");
    } catch (err) {
      log.error("app", "deploy step failed", err);
      setStatus("deploy", "error");
    }
  }, [connected, walletConfig, effNetwork, mode, addresses]);

  const handleProve = useCallback(async () => {
    if (!deployed) return;
    setStatus("prove", "running");
    log.info(
      "app",
      mode === "wallet"
        ? "=== CRITICAL STEP: proving via WALLET (no proof server). Watch for a Lace proving prompt / timing. ==="
        : "=== CONTROL STEP: proving via local proof server (localhost:6300). ===",
    );
    try {
      const r = await incrementCounter(deployed);
      setIncTx({
        txHash: r.public.txHash,
        blockHeight: r.public.blockHeight,
        status: String(r.public.status),
      });
      log.success("app", "increment proven, balanced, submitted.");
      setStatus("prove", "done");
    } catch (err) {
      log.error("app", "prove/increment step failed", err);
      setStatus("prove", "error");
    }
  }, [deployed, mode]);

  const handleResults = useCallback(async () => {
    if (!providers || !deployTx?.contractAddress) return;
    setStatus("results", "running");
    try {
      const r = await readCounterRound(providers, deployTx.contractAddress);
      setRound(r);
      setStatus("results", "done");
    } catch (err) {
      log.error("app", "results/query step failed", err);
      setStatus("results", "error");
    }
  }, [providers, deployTx]);

  return (
    <div className="mx-auto grid min-h-screen max-w-[1400px] grid-cols-1 gap-6 p-4 lg:grid-cols-2 lg:p-6">
      <div className="flex flex-col gap-4">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-lg">🌒</div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Lace in-wallet proving PoC</h1>
              <p className="text-xs text-muted-foreground">
                Discovery Q2 — does Lace prove ZK in-wallet via the dapp connector, with no proof server?
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
            <label className="flex items-center gap-2 text-xs font-medium">
              Network
              <select
                className="rounded border bg-background px-2 py-1 text-xs"
                value={network}
                onChange={(e) => setNetwork(e.target.value)}
                disabled={st.connect !== "idle" && st.connect !== "error"}
              >
                {Object.values(NETWORKS).map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label} ({n.id})
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-center gap-1 text-xs font-medium">
              Proof path
              <div className="ml-1 flex overflow-hidden rounded border">
                <button
                  type="button"
                  onClick={() => setMode("wallet")}
                  className={`px-2 py-1 ${mode === "wallet" ? "bg-primary text-primary-foreground" : "bg-background"}`}
                >
                  in-wallet
                </button>
                <button
                  type="button"
                  onClick={() => setMode("server")}
                  className={`px-2 py-1 ${mode === "server" ? "bg-primary text-primary-foreground" : "bg-background"}`}
                >
                  proof server
                </button>
              </div>
            </div>
          </div>
        </header>

        {/* Step 1 */}
        <StepCard index={1} title="Connect wallet" status={st.connect} subtitle="Detect window.midnight, authorize via the dapp connector, probe getProvingProvider.">
          <div className="flex flex-col gap-3">
            <Button onClick={handleConnect} disabled={st.connect === "running"}>
              {st.connect === "done" ? "Reconnect" : "Connect Lace"}
            </Button>
            <div className="flex flex-col gap-1.5">
              <KeyVal k="wallets injected" v={wallets.length === 0 ? "none" : wallets.map((w) => `${w.name} (${w.generation})`).join(", ")} />
              {connected && (
                <>
                  <KeyVal k="connected wallet" v={`${connected.wallet.name} · api ${connected.wallet.apiVersion ?? "?"}`} />
                  <KeyVal
                    k="in-wallet proving"
                    v={
                      <Badge variant={connected.supportsInWalletProving ? "success" : "warning"}>
                        {connected.supportsInWalletProving ? "getProvingProvider present" : "not advertised"}
                      </Badge>
                    }
                  />
                  <KeyVal k="network (wallet)" v={walletConfig?.networkId ?? "?"} />
                  <KeyVal k="indexer (wallet)" v={walletConfig?.indexerUri ?? "?"} />
                  <KeyVal k="proverServerUri" v={walletConfig?.proverServerUri ?? "(absent — good)"} />
                  {addresses && <KeyVal k="shielded addr" v={addresses.shielded} />}
                </>
              )}
            </div>
          </div>
        </StepCard>

        {/* Step 2 */}
        <StepCard index={2} title="Deploy test contract" status={st.deploy} disabled={st.connect !== "done"} subtitle="Deploy a trivial Counter, signed & balanced by the connected wallet.">
          <div className="flex flex-col gap-3">
            <Button onClick={handleDeploy} disabled={st.connect !== "done" || st.deploy === "running"}>
              Deploy counter
            </Button>
            {deployTx && (
              <div className="flex flex-col gap-1.5">
                <KeyVal k="contract address" v={deployTx.contractAddress} />
                <KeyVal k="deploy tx hash" v={deployTx.txHash} />
                <KeyVal k="block height" v={deployTx.blockHeight} />
                <KeyVal k="status" v={<Badge variant="success">{deployTx.status}</Badge>} />
              </div>
            )}
          </div>
        </StepCard>

        {/* Step 3 — THE critical step */}
        <StepCard
          index={3}
          title="Generate proof + call increment"
          status={st.prove}
          disabled={st.deploy !== "done"}
          subtitle={
            mode === "wallet"
              ? "Proof produced through the wallet connector — NO proof server configured by us."
              : "Control: proof produced by a local proof server at localhost:6300."
          }
        >
          <div className="flex flex-col gap-3">
            <Button onClick={handleProve} disabled={st.deploy !== "done" || st.prove === "running"}>
              {mode === "wallet" ? "Prove in wallet & increment" : "Prove via server & increment"}
            </Button>
            {incTx && (
              <div className="flex flex-col gap-1.5">
                <KeyVal k="increment tx hash" v={incTx.txHash} />
                <KeyVal k="block height" v={incTx.blockHeight} />
                <KeyVal k="status" v={<Badge variant="success">{incTx.status}</Badge>} />
              </div>
            )}
          </div>
        </StepCard>

        {/* Step 4 */}
        <StepCard index={4} title="Show results — confirm on-chain" status={st.results} disabled={st.prove !== "done"} subtitle="Query the indexer for the counter's on-chain value.">
          <div className="flex flex-col gap-3">
            <Button onClick={handleResults} disabled={st.prove !== "done" || st.results === "running"}>
              Query on-chain state
            </Button>
            {round !== undefined && (
              <div className="flex flex-col gap-1.5">
                <KeyVal
                  k="on-chain round"
                  v={round === null ? <Badge variant="warning">not found yet</Badge> : <Badge variant="success">{round.toString()}</Badge>}
                />
              </div>
            )}
          </div>
        </StepCard>
      </div>

      {/* Log panel */}
      <div className="lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)]">
        <LogPanel />
      </div>
    </div>
  );
}
