import { App, Modal, Setting, Notice } from 'obsidian';
import type LocalTranscriberPlugin from '../main';
import { runFileTranscriptionWithDiarization } from '../transcription/file/file-transcriber';

export class FileTranscribeModal extends Modal {
  private plugin: LocalTranscriberPlugin;
  private selectedFile: File | null = null;

  constructor(app: App, plugin: LocalTranscriberPlugin) {
    super(app);
    this.plugin = plugin;
    this.titleEl.setText('Transcribe file with diarization');
  }

  onOpen() {
    const { contentEl } = this;

    // File picker
    const fileInput = contentEl.createEl('input', {
      attr: {
        type: 'file',
        accept: 'audio/*,video/*',
      },
    });
    fileInput.style.display = 'block';
    fileInput.style.marginBottom = '1rem';
    fileInput.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.files && target.files.length > 0) {
        this.selectedFile = target.files[0] || null;
      }
    });

    // Number of speakers
    let speakersValue = 2;
    new Setting(contentEl)
      .setName('Number of speakers')
      .addDropdown((d) => {
        for (let i = 1; i <= 10; i++) {
          d.addOption(String(i), `${i}`);
        }
        d.setValue(String(speakersValue)).onChange((v) => {
          speakersValue = parseInt(v, 10);
        });
      });

    // Quality / model
    let qualityValue = 'base';
    new Setting(contentEl)
      .setName('Whisper model')
      .addDropdown((d) => {
        d.addOption('tiny', 'tiny (fast, lower quality)');
        d.addOption('base', 'base');
        d.addOption('small', 'small');
        d.addOption('medium', 'medium');
        d.addOption('large', 'large (slow, best quality)');
        d.setValue(qualityValue).onChange((v) => {
          qualityValue = v;
        });
      });

    // Submit
    new Setting(contentEl)
      .addButton((b) => {
        b.setButtonText('Transcribe');
        b.setCta();
        b.onClick(async () => {
          if (!this.selectedFile) {
            new Notice('Please select a file first.');
            return;
          }
          this.close();
          try {
            console.log('[LocalTranscriber] Starting transcription for file', this.selectedFile.name);
            await runFileTranscriptionWithDiarization(
              this.plugin,
              this.selectedFile,
              speakersValue,
              qualityValue
            );
            new Notice('Transcription started. Check the folder of your selected file for the .md output.');
          } catch (err) {
            console.error('[LocalTranscriber] Transcription failed', err);
            new Notice('Transcription failed. See console for details.');
          }
        });
      })
      .addButton((b) => {
        b.setButtonText('Cancel');
        b.onClick(() => this.close());
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}
