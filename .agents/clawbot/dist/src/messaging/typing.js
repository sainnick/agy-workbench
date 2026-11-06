const LEGACY_CHANNEL_MESSAGE = "openclaw/plugin-sdk/channel-message";
let factoryPromise;
export function loadTypingCallbacksFactory() {
    factoryPromise ??= import("openclaw/plugin-sdk/channel-outbound")
        .then(({ createTypingCallbacks }) => createTypingCallbacks)
        .catch(async (error) => {
        if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
            throw error;
        }
        const { createTypingCallbacks } = (await import(LEGACY_CHANNEL_MESSAGE));
        return createTypingCallbacks;
    });
    return factoryPromise;
}
//# sourceMappingURL=typing.js.map