import { App, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';                                                
    import { DEFAULT_SETTINGS, LocalTranscriberSettings, LocalTranscriberSettingTab } from "./settings";
    import { PythonEnvironment } from './environment/python';
    import { OllamaEnvironment } from './environment/ollama';
    import { OutputWriters } from './output-writers';                                                                    
    import { TranscriptionFile } from './transcription-file';                                                            
    import { TranscriptionLive } from './transcription-live';
    import { LiveSessionManager } from './live-session';                                                                 
    import { Diagnostics } from './diagnostics';
    import { ModelRegistry } from './models/registry';                                                                   
    import { ModelDiscovery } from './models/discovery';
    import { VIEW_TYPE_LIVE_DICTATION, LiveDictationView } from './ui/live-modal';
                                                                                                                         
    export default class LocalTranscriberPlugin extends Plugin {                                                         
        settings: LocalTranscriberSettings;
        statusBarItem: HTMLElement;                                                                                      
        pythonEnv: PythonEnvironment;                                                                                    
        ollamaEnv: OllamaEnvironment;
        outputWriters: OutputWriters;                                                                                    
        transcriptionFile: TranscriptionFile;
        transcriptionLive: TranscriptionLive;
        liveSessionManager: LiveSessionManager;                                                                          
        diagnostics: Diagnostics;                                                                                        
        modelRegistry: ModelRegistry;
        modelDiscovery: ModelDiscovery;                                                                                  
                                                                                                                         
        async onload() {                                                                                                 
                await this.loadSettings();                                                                               
                this.statusBarItem = this.addStatusBarItem();
                this.updateStatusBarIcon(false);                                                                         
                                                                                                                         
                this.pythonEnv = new PythonEnvironment(this);
                this.ollamaEnv = new OllamaEnvironment();                                                                
                this.outputWriters = new OutputWriters(this);
                this.transcriptionFile = new TranscriptionFile(this);                                                    
                this.liveSessionManager = new LiveSessionManager(this);
                this.transcriptionLive = new TranscriptionLive(this);
                this.diagnostics = new Diagnostics(this);                                                                
                this.modelRegistry = new ModelRegistry();
                this.modelDiscovery = new ModelDiscovery(this.modelRegistry, this.ollamaEnv);
                                                                                                                         
                this.modelDiscovery.refreshAll(this.settings.availableModels).catch(e => console.error(e));
                                                                                                                         
                this.registerView(                                                                                       
                        VIEW_TYPE_LIVE_DICTATION,                                                                        
                        (leaf: WorkspaceLeaf) => new LiveDictationView(leaf, this)
                );                                                                                                       
                                                                                                                         
                this.addRibbonIcon('audio-waveform', 'Open Live Dictation', async () => {
                	const leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getRightLeaf(true);
                	if (leaf instanceof WorkspaceLeaf) {
                		await leaf.setViewState({ type: VIEW_TYPE_LIVE_DICTATION });
                		this.app.workspace.revealLeaf(leaf);
                	}
                });
                                                                                                                         
                this.addCommand({                                                                                        
                        id: 'toggle-live-transcription',
                        name: 'Toggle live transcription',                                                               
                        callback: async () => {                                                                          
                                if (this.transcriptionLive.isRecording()) {
                                        await this.transcriptionLive.stopRecording();
                                        this.updateStatusBarIcon(false);                                                 
                                } else {                                                                                 
                                        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIVE_DICTATION);     
                                        const activeLeaf = leaves[0];                                                    
                                        if (activeLeaf && activeLeaf.view) {
                                                const view = activeLeaf.view as LiveDictationView;
                                                await this.transcriptionLive.handleTranscribeLive(view);                 
                                                await this.transcriptionLive.startRecording(this.settings.liveMicDeviceId || 'default');
                                                this.updateStatusBarIcon(true);                                          
                                        } else {
                                                new Notice("Please open the Live Dictation sidebar first (via Ribbon icon).");                                                                                                                    
                                        }                                                                                
                                }                                                                                        
                        }
                });                                                                                                      
                                                                                                                         
                this.addSettingTab(new LocalTranscriberSettingTab(this.app, this));
        }                                                                                                                
                                                                                                                         
        updateStatusBarIcon(isRecording: boolean) {                                                                      
                this.statusBarItem.setText(isRecording ? '🎙 REC' : '🎙 STOP');
                this.statusBarItem.style.color = isRecording ? 'var(--text-accent)' : 'var(--text-muted)';
        }                                                                                                                
                                                                                                                         
        async loadSettings() {                                                                                           
                this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<LocalTranscriberSettings>);
        }                                                                                                                
                                                                                                                         
        async saveSettings() {                                                                                           
                await this.saveData(this.settings);                                                                      
        }
    }
       