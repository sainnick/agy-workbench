import { resolveChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
export async function resolveWeixinInboundAuthorization(params) {
    const shouldComputeCommand = params.commands.shouldComputeCommandAuthorized(params.rawBody, params.config);
    // Legacy accounts without a saved owner allow messages but do not authorize commands.
    if (params.allowFrom.length === 0) {
        return { senderAllowed: true, commandAuthorized: shouldComputeCommand ? false : undefined };
    }
    const ingress = await resolveChannelMessageIngress({
        channelId: "openclaw-weixin",
        accountId: params.accountId,
        identity: { primary: { normalize: (value) => value, sensitivity: "pii" } },
        subject: { stableId: params.senderId },
        conversation: { kind: "direct", id: params.senderId },
        event: { kind: "message", authMode: "inbound", mayPair: true },
        policy: { dmPolicy: "pairing", groupPolicy: "disabled" },
        readStoreAllowFrom: async () => params.allowFrom,
        ...(shouldComputeCommand
            ? { command: { allowTextCommands: true, hasControlCommand: true } }
            : {}),
    });
    return {
        senderAllowed: ingress.senderAccess.allowed,
        commandAuthorized: shouldComputeCommand ? ingress.commandAccess.authorized : undefined,
    };
}
//# sourceMappingURL=authorization.js.map