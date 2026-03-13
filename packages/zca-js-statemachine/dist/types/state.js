export function createInitialState(opts) {
    return {
        version: 1,
        phase: 'idle',
        credentials: opts.credentials ?? null,
        userProfile: null,
        qrData: null,
        cipherKey: null,
        wsUrl: null,
        pingIntervalMs: 20000,
        errorMessage: null,
        reconnectCount: 0,
        lastConnectedAt: null,
        userAgent: opts.userAgent ?? 'Mozilla/5.0',
        language: opts.language ?? 'vi',
    };
}
//# sourceMappingURL=state.js.map