import { MetaBind, MetaBindBuild } from 'meta-bind-core/src';
import { DomHelpers } from 'meta-bind-core/src/api/DomHelpers';
import { RenderChildType } from 'meta-bind-core/src/config/APIConfigs';
import { EMBED_MAX_DEPTH } from 'meta-bind-core/src/config/FieldConfigs';
import { IntervalCycleScheduler } from 'meta-bind-core/src/metadata/CycleScheduler';
import {
	GlobalMetadataSource,
	InternalMetadataSource,
	ScopeMetadataSource,
} from 'meta-bind-core/src/metadata/InternalMetadataSources';
import { MetadataManager } from 'meta-bind-core/src/metadata/MetadataManager';
import { BindTargetStorageType } from 'meta-bind-core/src/parsers/bindTargetParser/BindTargetDeclaration';
import type { MetaBindPluginSettings } from 'meta-bind-core/src/Settings';
import { registerCm5HLModes } from 'meta-bind-obsidian/src/cm6/Cm5_Modes';
import { createMarkdownRenderChildWidgetEditorPlugin } from 'meta-bind-obsidian/src/cm6/Cm6_ViewPlugin';
import { DependencyManager } from 'meta-bind-obsidian/src/dependencies/DependencyManager';
import { Version } from 'meta-bind-obsidian/src/dependencies/Version';
import { createEditorMenu } from 'meta-bind-obsidian/src/EditorMenu';
import type ObsMetaBindPlugin from 'meta-bind-obsidian/src/main';
import { ObsAPI } from 'meta-bind-obsidian/src/ObsAPI';
import { ObsFileAPI } from 'meta-bind-obsidian/src/ObsFileAPI';
import { ObsInternalAPI } from 'meta-bind-obsidian/src/ObsInternalAPI';
import { ObsMetadataSource } from 'meta-bind-obsidian/src/ObsMetadataSource';
import { ObsNotePosition } from 'meta-bind-obsidian/src/ObsNotePosition';
import { PlaygroundView, MB_PLAYGROUND_VIEW_TYPE } from 'meta-bind-obsidian/src/playground/PlaygroundView';
import { MetaBindSettingTab } from 'meta-bind-obsidian/src/settings/SettingsTab';
import type { App, MarkdownPostProcessorContext, WorkspaceLeaf } from 'obsidian';
import { debounce, loadPrism, stringifyYaml } from 'obsidian';

class ObsDomHelpers extends DomHelpers {
	override get activeDocument(): Document {
		return activeDocument;
	}
}

export interface ObsComponents {
	api: ObsAPI;
	internal: ObsInternalAPI;
	file: ObsFileAPI;
}

export class ObsMetaBind extends MetaBind<ObsComponents> {
	app: App;
	plugin: ObsMetaBindPlugin;

	dependencyManager: DependencyManager;

	constructor(plugin: ObsMetaBindPlugin) {
		super();

		this.app = plugin.app;
		this.plugin = plugin;
		this.domHelpers = new ObsDomHelpers();

		this.setComponents({
			api: new ObsAPI(this),
			internal: new ObsInternalAPI(this),
			file: new ObsFileAPI(this),
		});

		const settingTab = new MetaBindSettingTab(this.app, this);
		this.plugin.addSettingTab(settingTab);
		this.app.workspace.onLayoutReady(() => {
			const refreshSettings = debounce(() => settingTab.update(), 200, true);
			settingTab.update();
			this.plugin.registerEvent(this.app.vault.on('create', refreshSettings));
			this.plugin.registerEvent(this.app.vault.on('delete', refreshSettings));
			this.plugin.registerEvent(this.app.vault.on('rename', refreshSettings));
		});

		// check dependencies
		this.dependencyManager = new DependencyManager(this, []);
		this.setUpDependencies();

		this.setUpMetadataManager();

		this.loadTemplates();

		// register all post processors for MDRCs
		this.addPostProcessors();
		this.plugin.registerEditorExtension(createMarkdownRenderChildWidgetEditorPlugin(this));

		this.addCommands();
		registerCm5HLModes(this);

		// misc
		this.plugin.registerView(MB_PLAYGROUND_VIEW_TYPE, leaf => new PlaygroundView(leaf, this));
		this.addStatusBarBuildIndicator();

		if (this.getSettings().enableEditorRightClickMenu) {
			this.plugin.registerEvent(
				this.app.workspace.on('editor-menu', (menu, editor) => {
					createEditorMenu(menu, editor, this);
				}),
			);
		}
	}

	private setUpDependencies(): void {
		this.dependencyManager.dependencies = [
			{
				name: 'Dataview',
				pluginId: 'dataview',
				minVersion: new Version(0, 5, 64),
			},
			{
				name: 'JS Engine',
				pluginId: 'js-engine',
				minVersion: new Version(0, 3, 5),
			},
			{
				name: 'Templater',
				pluginId: 'templater-obsidian',
				minVersion: new Version(2, 2, 3),
			},
		];
	}

	private setUpMetadataManager(): void {
		this.metadataManager = new MetadataManager();
		this.metadataManager.registerSource(
			new ObsMetadataSource(this, BindTargetStorageType.FRONTMATTER, this.metadataManager),
		);
		this.metadataManager.registerSource(
			new InternalMetadataSource(BindTargetStorageType.MEMORY, this.metadataManager),
		);
		this.metadataManager.registerSource(
			new GlobalMetadataSource(BindTargetStorageType.GLOBAL_MEMORY, this.metadataManager),
		);
		this.metadataManager.registerSource(new ScopeMetadataSource(BindTargetStorageType.SCOPE, this.metadataManager));
		this.metadataManager.setDefaultSource(BindTargetStorageType.FRONTMATTER);

		this.plugin.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				this.mountableManager.unloadFile(oldPath);
				this.metadataManager.onStoragePathRenamed(oldPath, file.path);
			}),
		);

		this.plugin.registerEvent(
			this.app.vault.on('delete', file => {
				this.mountableManager.unloadFile(file.path);
				this.metadataManager.onStoragePathDeleted(file.path);
			}),
		);

		// The cycle timer is gated on outstanding metadata work, so it does not tick at all while
		// nothing is bound. `registerInterval` is not usable here because the interval is created
		// and cleared repeatedly over a session; the scheduler is torn down on unload instead.
		const cycleScheduler = new IntervalCycleScheduler(
			() => void this.metadataManager.cycle(),
			this.getSettings().syncInterval,
		);
		this.plugin.register(() => cycleScheduler.stop());
		this.metadataManager.setCycleScheduler(cycleScheduler);
	}

	private addPostProcessors(): void {
		// In every processor we await prism to load, otherwise prism may break our rendering.
		// Luckily `await loadPrism()` is a no-op if prism is already loaded.
		// We could also load prism once on startup, but that would add 100+ms to the reported plugin load time.
		// Prism is always loaded, so the total startup time would be the same, but the higher reported time may scare users.

		// inline code blocks
		this.plugin.registerMarkdownPostProcessor((el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
			const codeBlocks = el.querySelectorAll('code');
			const filePath = ctx.sourcePath;

			for (let index = 0; index < codeBlocks.length; index++) {
				const codeBlock = codeBlocks.item(index);

				if (codeBlock.hasClass('mb-none')) {
					continue;
				}

				const content = codeBlock.innerText;
				const fieldType = this.api.isInlineFieldDeclarationAndGetType(content);
				if (fieldType === undefined) {
					continue;
				}

				const mountable = this.api.createInlineFieldOfTypeFromString(fieldType, content, filePath, undefined);
				this.api.wrapInMDRC(mountable, codeBlock, ctx);
			}
		}, 1);

		// "meta-bind" code blocks
		this.plugin.registerMarkdownCodeBlockProcessor('meta-bind', async (source, el, ctx) => {
			await loadPrism();

			const codeBlock = el;
			const content = source.trim();
			const filePath = ctx.sourcePath;

			const fieldType = this.api.isInlineFieldDeclarationAndGetType(content);
			if (fieldType === undefined) {
				return;
			}

			const mountable = this.api.createInlineFieldOfTypeFromString(
				fieldType,
				content,
				filePath,
				undefined,
				RenderChildType.BLOCK,
				new ObsNotePosition(ctx, el),
			);
			this.api.wrapInMDRC(mountable, codeBlock, ctx);
		});

		// "meta-bind-js-view" code blocks
		this.plugin.registerMarkdownCodeBlockProcessor('meta-bind-js-view', async (source, el, ctx) => {
			await loadPrism();

			const mountable = this.api.createJsViewFieldMountable(ctx.sourcePath, {
				declaration: source,
			});

			this.api.wrapInMDRC(mountable, el, ctx);
		});

		// "meta-bind-embed" code blocks
		this.plugin.registerMarkdownCodeBlockProcessor('meta-bind-embed', async (source, el, ctx) => {
			await loadPrism();

			const mountable = this.api.createEmbedMountable(ctx.sourcePath, {
				content: source,
				depth: 0,
			});

			this.api.wrapInMDRC(mountable, el, ctx);
		});

		for (let i = 1; i <= EMBED_MAX_DEPTH; i++) {
			this.plugin.registerMarkdownCodeBlockProcessor(`meta-bind-embed-internal-${i}`, async (source, el, ctx) => {
				await loadPrism();

				const mountable = this.api.createEmbedMountable(ctx.sourcePath, {
					content: source,
					depth: i,
				});

				this.api.wrapInMDRC(mountable, el, ctx);
			});
		}

		// "meta-bind-button" code blocks
		this.plugin.registerMarkdownCodeBlockProcessor('meta-bind-button', async (source, el, ctx) => {
			await loadPrism();

			const mountable = this.api.createButtonMountable(ctx.sourcePath, {
				declaration: source,
				isPreview: false,
				position: new ObsNotePosition(ctx, el),
			});

			this.api.wrapInMDRC(mountable, el, ctx);
		});
	}

	private addCommands(): void {
		this.plugin.addCommand({
			id: 'open-docs',
			name: 'Open docs',
			callback: () => {
				window.open('https://moritzjung.dev/obsidian-meta-bind-plugin-docs/', '_blank');
			},
		});

		this.plugin.addCommand({
			id: 'open-playground',
			name: 'Open playground',
			callback: () => {
				void this.activateView(MB_PLAYGROUND_VIEW_TYPE);
			},
		});

		this.plugin.addCommand({
			id: 'open-help',
			name: 'Open help',
			callback: () => {
				void this.activateView(MB_PLAYGROUND_VIEW_TYPE);
			},
		});

		this.plugin.addCommand({
			id: 'open-button-builder',
			name: 'Open button builder',
			callback: () => {
				this.internal.openButtonBuilderModal({
					onOkay: (config): void => {
						void window.navigator.clipboard.writeText(
							`\`\`\`meta-bind-button\n${stringifyYaml(config)}\n\`\`\``,
						);
					},
					submitText: 'Copy to clipboard',
				});
			},
		});

		this.plugin.addCommand({
			id: 'copy-command-id',
			name: 'Select and copy command ID',
			callback: () => {
				this.internal.openCommandSelectModal(command => {
					void window.navigator.clipboard.writeText(command.id);
				});
			},
		});
	}

	private addStatusBarBuildIndicator(): void {
		if (this.build === MetaBindBuild.DEV) {
			const item = this.plugin.addStatusBarItem();
			item.setText('Meta Bind Dev Build');
			item.addClass('mb-error');
			this.plugin.register(() => item.remove());
		}

		if (this.build === MetaBindBuild.CANARY) {
			const item = this.plugin.addStatusBarItem();
			item.setText(`Meta Bind Canary Build (${MB_VERSION})`);
			item.addClass('mb-error');
			this.plugin.register(() => item.remove());
		}
	}

	async activateView(viewType: string): Promise<void> {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null;
		const leaves = workspace.getLeavesOfType(viewType);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			leaf = workspace.getLeaf('tab');
			await leaf.setViewState({ type: viewType, active: true });
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		await workspace.revealLeaf(leaf);
	}

	getSettings(): MetaBindPluginSettings {
		return this.plugin.settings;
	}

	saveSettings(settings: MetaBindPluginSettings): void {
		this.plugin.settings = settings;
		void this.plugin.saveSettings();
	}
}
