(() => {
    const api = window.updateApi;
    if (!api) return;
    const byId = (id) => document.getElementById(id);
    const check = byId('updates-check');
    const download = byId('updates-download');
    const install = byId('updates-install');
    const later = byId('updates-later');
    let latest; let dismissed; let token;
    const dirtyDialogs = new Set();
    const frozen = new Map();
    const activity = byId('updates-activity');
    function freezeEditing() {
        for (const element of document.body.children) {
            if (element === activity || frozen.has(element)) continue;
            frozen.set(element, element.inert); element.inert = true;
        }
        activity.classList.remove('hidden');
        activity.textContent = 'Checking that meeting work is saved…';
    }
    function releaseEditing() {
        for (const [element, inert] of frozen) element.inert = inert;
        frozen.clear(); activity.classList.add('hidden');
    }
    document.addEventListener('input', (event) => {
        const dialog = event.target.closest('.modal-overlay');
        if (dialog && dialog.id !== 'settings-modal') dirtyDialogs.add(dialog);
        if (dialog?.id === 'settings-modal') dirtyDialogs.add(dialog);
    });
    const dialogObserver = new MutationObserver(() => {
        for (const dialog of dirtyDialogs) if (dialog.classList.contains('hidden')) dirtyDialogs.delete(dialog);
    });
    document.querySelectorAll('.modal-overlay').forEach((dialog) => dialogObserver.observe(dialog, { attributes: true, attributeFilter: ['class'] }));
    function render(value) {
        if (!value) return;
        latest = value;
        const busy = ['checking', 'downloading', 'preparing', 'installing'].includes(value.phase);
        byId('updates-version').textContent = `${value.version} · ${value.channel || 'unsupported'} channel`;
        const messages = {
            idle: 'Updates are checked automatically while the app is running.',
            checking: 'Checking for updates…', current: 'No newer same-channel update is available.',
            available: `Version ${value.availableVersion} is available.`,
            downloading: `Downloading ${value.availableVersion}… ${Math.floor(value.progress || 0)}%`,
            downloaded: `Version ${value.downloadedVersion} is downloaded and verified. Ready to install.`,
            preparing: 'Checking that meeting work is saved…', installing: 'Installing and restarting…',
            error: 'Update failed. You can retry.',
        };
        const retry = value.retryAt ? ` Retry after ${new Date(value.retryAt).toLocaleString()}.` : '';
        byId('updates-status').textContent = (value.error || messages[value.phase] || 'Updates unavailable.') + retry;
        if (token) activity.textContent = value.error || messages[value.phase] || 'Preparing the update…';
        check.disabled = busy;
        check.textContent = value.phase === 'error' && !value.availableVersion ? 'Retry check' : 'Check for updates';
        download.classList.toggle('hidden', !value.availableVersion || !!value.downloadedVersion || busy);
        download.textContent = value.phase === 'error' ? 'Retry download' : 'Download update';
        install.classList.toggle('hidden', !value.downloadedVersion || busy);
        later.classList.toggle('hidden', !value.availableVersion || busy);
        byId('updates-progress').classList.toggle('hidden', value.phase !== 'downloading');
        byId('updates-progress').value = value.progress || 0;
        byId('updates-indicator').classList.toggle('hidden', !value.availableVersion || dismissed === value.availableVersion);
    }
    async function action(name) {
        try { render(await api[name]()); }
        catch (error) { byId('updates-status').textContent = error.message || 'Update action failed. Try again.'; }
    }
    check.addEventListener('click', () => action('check'));
    download.addEventListener('click', () => action('download'));
    install.addEventListener('click', () => action('install'));
    later.addEventListener('click', () => { dismissed = latest?.availableVersion; render(latest); });
    api.onStatus(render);
    api.status().then(render).catch(() => { byId('updates-status').textContent = 'Update status unavailable. Reopen the app and retry.'; });
    window.updateReadiness.onPrepare(async (value) => {
        token = value;
        freezeEditing();
        try {
            const noteError = window.notesList?.updateReadinessError();
            if (noteError) throw new Error(noteError);
            if ([...dirtyDialogs].some((dialog) => !dialog.classList.contains('hidden'))) throw new Error('Save or close the edited dialog, then click Install again.');
            for (const mode of ['live', 'record']) {
                const setup = byId(`${mode}-setup`);
                if (window[`${mode}UpdateTitleDraft`]?.() && setup && !setup.classList.contains('hidden')) throw new Error('Finish or clear the pending meeting title, then click Install again.');
            }
            const chat = byId('chat-input');
            if (chat?.value.trim()) throw new Error('Finish or clear the chat draft, then click Install again.');
            if (!window.prepareEditorForUpdate) throw new Error('The editor is not ready. Reopen the app and retry.');
            await window.prepareEditorForUpdate();
            if (token !== value) return;
            window.updateReadiness.ready({ token: value, ok: true });
        } catch (error) { if (token === value) window.updateReadiness.ready({ token: value, ok: false, error: error.message }); }
    });
    window.updateReadiness.onRelease((value) => {
        if (token !== value) return;
        token = null;
        releaseEditing();
    });
})();
