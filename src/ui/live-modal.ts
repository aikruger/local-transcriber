import { ItemView, WorkspaceLeaf } from 'obsidian';
import LocalTranscriberPlugin from '../main';

export const VIEW_TYPE_LIVE_DICTATION = "live-dictation-view";

export class LiveDictationView extends ItemView {
    plugin: LocalTranscriberPlugin;

    private startBtn: HTMLButtonElement;
    private pauseBtn: HTMLButtonElement;
    private stopBtn: HTMLButtonElement;
    private micSelect: HTMLSelectElement;

    private statusLabel: HTMLElement;
    private timeLabel: HTMLElement;
    private backlogLabel: HTMLElement;

    private previewBox: HTMLElement;
    private micLevelBar: HTMLElement;

    private _onStartClick: ((micId: string) => void) | null = null;
    private _onPauseClick: (() => void) | null = null;
    private _onStopClick: (() => void) | null = null;

    private audioContext: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private mediaStream: MediaStream | null = null;
    private drawFrame: number = 0;

    constructor(leaf: WorkspaceLeaf, plugin: LocalTranscriberPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string { return VIEW_TYPE_LIVE_DICTATION; }
    getDisplayText(): string { return "Live Dictation"; }

    async onOpen() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.createEl("h4", { text: "Live Dictation" });
        this.renderUI(container);
    }

    renderUI(container: HTMLElement) {
        const controlsDiv = container.createDiv({ cls: 'live-transcribe-controls' });
        controlsDiv.style.display = 'flex';
        controlsDiv.style.flexDirection = 'column';
        controlsDiv.style.gap = '10px';
        controlsDiv.style.marginBottom = '10px';

        this.micSelect = container.createEl('select', { cls: 'dropdown' });
        controlsDiv.appendChild(this.micSelect);

        const buttonsDiv = container.createDiv({ cls: 'live-transcribe-buttons' });
        buttonsDiv.style.display = 'flex';
        buttonsDiv.style.gap = '10px';
        buttonsDiv.style.alignItems = 'center';

        this.startBtn = buttonsDiv.createEl('button', { text: 'Start' });
        this.startBtn.addClass('mod-cta');
        
        this.pauseBtn = buttonsDiv.createEl('button', { text: 'Pause' });
        this.pauseBtn.disabled = true;
        
        this.stopBtn = buttonsDiv.createEl('button', { text: 'Stop' });
        this.stopBtn.disabled = true;
        
        controlsDiv.appendChild(buttonsDiv);

        const levelContainer = container.createDiv();
        levelContainer.style.width = '100%';
        levelContainer.style.height = '10px';
        levelContainer.style.backgroundColor = '#333';
        levelContainer.style.borderRadius = '5px';
        levelContainer.style.overflow = 'hidden';
        levelContainer.style.marginBottom = '10px';

        this.micLevelBar = levelContainer.createDiv();
        this.micLevelBar.style.width = '0%';
        this.micLevelBar.style.height = '100%';
        this.micLevelBar.style.backgroundColor = '#4caf50';

        const infoDiv = container.createDiv();
        infoDiv.style.display = 'flex';
        infoDiv.style.flexDirection = 'column';
        infoDiv.style.gap = '5px';
        infoDiv.style.fontSize = '0.9em';
        infoDiv.style.color = 'var(--text-muted)';

        this.statusLabel = infoDiv.createDiv({ text: 'Status: Idle' });
        this.timeLabel = infoDiv.createDiv({ text: 'Time: 00:00' });
        this.backlogLabel = infoDiv.createDiv({ text: 'Backlog: 0s' });

        this.previewBox = container.createDiv({ cls: 'live-transcribe-preview' });
        this.previewBox.style.padding = '10px';
        this.previewBox.style.border = '1px solid var(--background-modifier-border)';
        this.previewBox.innerText = 'Preview...';

        this.populateMics();

        this.startBtn.onclick = () => {
            if (this._onStartClick) this._onStartClick(this.micSelect.value);
        };
        this.pauseBtn.onclick = () => { if (this._onPauseClick) this._onPauseClick(); };
        this.stopBtn.onclick = () => { if (this._onStopClick) this._onStopClick(); };
    }

    async populateMics() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(d => d.kind === 'audioinput');
            for (const dev of audioInputs) {
                const opt = document.createElement('option');
                opt.value = dev.deviceId;
                opt.text = dev.label || `Mic ${this.micSelect.options.length + 1}`;
                this.micSelect.appendChild(opt);
            }
        } catch (e) {}
    }

    async startMicLevel() {
        try {
            this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: this.micSelect.value } });
            this.audioContext = new AudioContext();
            this.analyser = this.audioContext.createAnalyser();
            this.drawMicLevel();
        } catch (e) {}
    }

    stopMicLevel() {
        cancelAnimationFrame(this.drawFrame);
        if (this.mediaStream) this.mediaStream.getTracks().forEach(t => t.stop());
        if (this.audioContext) this.audioContext.close();
        this.micLevelBar.style.width = '0%';
    }

    drawMicLevel = () => {
        if (!this.analyser) return;
        const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b) / dataArray.length;
        this.micLevelBar.style.width = `${Math.min(100, (avg / 128) * 100)}%`;
        this.drawFrame = requestAnimationFrame(this.drawMicLevel);
    }

    async onClose() { this.stopMicLevel(); }
    onStartClick(cb: (micId: string) => void) { this._onStartClick = cb; }
    onPauseClick(cb: () => void) { this._onPauseClick = cb; }
    onStopClick(cb: () => void) { this._onStopClick = cb; }

    setRecordingState(state: 'idle' | 'recording' | 'paused') {
        const rec = state === 'recording';
        this.startBtn.disabled = rec;
        this.pauseBtn.disabled = !rec;
        this.stopBtn.disabled = !rec && state !== 'paused';
        if (rec) this.startMicLevel(); else this.stopMicLevel();
    }

    log(msg: string) { console.log(`[Dictation UI] ${msg}`); }
    setPreviewText(text: string) { this.previewBox.innerText = text; }

    setTranscriptionProgress(recorded: number, transcribed: number, isProcessing: boolean) {
        this.timeLabel.innerText = `Time: ${recorded.toFixed(0)}s / ${transcribed.toFixed(0)}s`;
        this.statusLabel.innerText = isProcessing ? "Status: Processing" : "Status: Listening";
    }
}
