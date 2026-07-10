import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { runWalletCheck, type WalletCheckResult } from './wallet-check';
import { report, describeOpener, type Transport } from './report';

export default function App() {
  const [result, setResult] = useState<WalletCheckResult | null>(null);
  const [transport, setTransport] = useState<Transport | 'pending'>('pending');
  const [checkCount, setCheckCount] = useState(0);

  const check = useCallback(async () => {
    const res = runWalletCheck();
    setResult(res);
    setCheckCount((n) => n + 1);
    setTransport('pending');
    const used = await report('wallet-check', { ...res, openerState: describeOpener() });
    setTransport(used);
    await report('log', {
      text:
        'wallet-check delivered via ' +
        used +
        ' | ' +
        describeOpener() +
        ' | midnight=' +
        String(res.midnightPresent) +
        ' cardano=' +
        String(res.cardanoPresent),
      level: 'info',
    });
  }, []);

  useEffect(() => {
    // Give extension content-scripts a moment to inject after load.
    const t = setTimeout(() => {
      void check();
    }, 600);
    return () => clearTimeout(t);
  }, [check]);

  return (
    <div className="min-h-screen bg-background flex items-start justify-center p-8">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl">Nyx PoC DApp</CardTitle>
            <Badge variant="secondary">inside WebContainer</Badge>
          </div>
          <CardDescription>
            Vite + React 19 + shadcn + Tailwind v4, served by a dev server running in a
            StackBlitz WebContainer. This page checks whether the Lace (Midnight) extension
            injects <code className="font-mono">window.midnight</code> into this top-level
            preview origin.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Origin:</span>
            <code className="font-mono text-xs bg-muted px-2 py-1 rounded">
              {typeof location !== 'undefined' ? location.origin : ''}
            </code>
          </div>

          {result === null ? (
            <p className="text-muted-foreground text-sm">Running wallet check…</p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">window.midnight</span>
                {result.midnightPresent ? (
                  <Badge variant="success">PRESENT</Badge>
                ) : (
                  <Badge variant="destructive">absent</Badge>
                )}
              </div>
              {result.midnightPresent && (
                <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto">
                  {JSON.stringify(result.midnightKeys, null, 2)}
                </pre>
              )}
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">window.cardano</span>
                {result.cardanoPresent ? (
                  <Badge variant="success">PRESENT</Badge>
                ) : (
                  <Badge variant="destructive">absent</Badge>
                )}
              </div>
              {result.cardanoPresent && (
                <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto">
                  {JSON.stringify(result.cardanoKeys, null, 2)}
                </pre>
              )}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">Other wallet-looking globals</span>
                {result.otherWalletGlobals.length === 0 ? (
                  <span className="text-muted-foreground text-sm">(none)</span>
                ) : (
                  result.otherWalletGlobals.map((g) => (
                    <Badge key={g} variant="outline">
                      {g}
                    </Badge>
                  ))
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Reported to server via</span>
                {transport === 'pending' ? (
                  <Badge variant="secondary">sending…</Badge>
                ) : transport === 'none' ? (
                  <Badge variant="destructive">FAILED (all transports)</Badge>
                ) : (
                  <Badge variant="success">{transport}</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{describeOpener()}</p>
            </div>
          )}
        </CardContent>
        <CardFooter className="gap-3">
          <Button onClick={() => void check()}>Re-check wallets</Button>
          <span className="text-xs text-muted-foreground">checks run: {checkCount}</span>
        </CardFooter>
      </Card>
    </div>
  );
}
