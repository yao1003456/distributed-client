
import React from 'react';

interface WalletConnectProps {
    address: string;
    isLoggedIn: boolean;
    status: string;
    connectWallet: () => Promise<void>;
    signInWithEthereum: () => Promise<void>;
}

export const WalletConnect: React.FC<WalletConnectProps> = ({
    address,
    isLoggedIn,
    status,
    connectWallet,
    signInWithEthereum
}) => {
    return (
        <div style={{ marginBottom: 20 }}>
            <p>Status: {status}</p>

            {!address ? (
                <button onClick={connectWallet}>Connect Wallet</button>
            ) : (
                <div>
                    <p>Connected: {address}</p>
                    {!isLoggedIn && <button onClick={signInWithEthereum}>Login (SIWE)</button>}
                    {isLoggedIn && <p style={{ color: 'green' }}>✓ Logged in (keys secured in enclave)</p>}
                </div>
            )}
        </div>
    );
};
