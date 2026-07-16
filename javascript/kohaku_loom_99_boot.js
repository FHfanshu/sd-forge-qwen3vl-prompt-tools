(function () {
    var ui = window.KohakuLoomSvelteUi;
    if (!ui || ui.UI_READY !== true || typeof window.onUiLoaded !== "function") return;
    window.onUiLoaded(function () {
        var readyUi = window.KohakuLoomSvelteUi;
        if (!readyUi || readyUi.UI_READY !== true || typeof readyUi.mountSvelteUi !== "function") return;
        readyUi.mountSvelteUi();
    });
})();
