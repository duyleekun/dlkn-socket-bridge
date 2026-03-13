export function selectSessionView(snapshot) {
    const ctx = snapshot.context;
    return {
        phase: snapshot.value,
        isConnected: snapshot.value === 'listening',
        isLoggedIn: ctx.credentials !== null,
        hasQrCode: ctx.qrData !== null,
        qrImage: ctx.qrData?.image,
        qrToken: ctx.qrData?.token,
        userProfile: ctx.userProfile ?? undefined,
        errorMessage: ctx.errorMessage ?? undefined,
        wsUrl: ctx.wsUrl ?? undefined,
    };
}
//# sourceMappingURL=session-view.js.map