
import React from 'react';

interface WalletConnectProps {
    address: string;
    isLoggedIn: boolean;
    connectWallet: () => Promise<void>;
    signInWithEthereum: () => Promise<void>;
}

export const WalletConnect: React.FC<WalletConnectProps> = ({
    address,
    isLoggedIn,
    connectWallet,
    signInWithEthereum
}) => {
    return (
        <div className="flex flex-col items-end gap-sm">
            {!address ? (
                <button className="btn btn-primary" onClick={connectWallet}>
                    Connect Wallet
                </button>
            ) : (
                <div className="flex items-center gap-sm">
                    <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', fontFamily: 'monospace' }}>
                        {address}
                    </span>
                    {!isLoggedIn && (
                        <button className="btn btn-primary animate-fade-in" onClick={signInWithEthereum}>
                            Login (SIWE)
                        </button>
                    )}
                    {isLoggedIn && (
                        <span className="status-badge success animate-fade-in">
                            ✓ Verified
                        </span>
                    )}
                </div>
            )}
        </div>
    );
};
