import { MetaBind } from 'meta-bind-core/src';
import { DomHelpers } from 'meta-bind-core/src/api/DomHelpers';
import { RenderChildType } from 'meta-bind-core/src/config/APIConfigs';
import { EMBED_MAX_DEPTH } from 'meta-bind-core/src/config/FieldConfigs';
import { IntervalCycleScheduler } from 'meta-bind-core/src/metadata/CycleScheduler';
import { GlobalMetadataSource, InternalMetadataSource } from 'meta-bind-core/src/metadata/InternalMetadataSources';
import { MetadataManager } from 'meta-bind-core/src/metadata/MetadataManager';
import { MountableManager } from 'meta-bind-core/src/MountableManager';
import { BindTargetStorageType } from 'meta-bind-core/src/parsers/bindTargetParser/BindTargetDeclaration';
import type { MetaBindPluginSettings } from 'meta-bind-core/src/Settings';
import { setFirstWeekday } from 'meta-bind-core/src/utils/DatePickerUtils';
import { PublishAPI } from 'meta-bind-publish/src/PublishAPI';
import { PublishFileAPI } from 'meta-bind-publish/src/PublishFileAPI';
import { PublishInternalAPI } from 'meta-bind-publish/src/PublishInternalAPI';
import { PublishMetadataSource } from 'meta-bind-publish/src/PublishMetadataSource';
import { PublishNotePosition } from 'meta-bind-publish/src/PublishNotePosition';
import type { MarkdownPostProcessorContext } from 'obsidian/publish';

class PublishDomHelpers extends DomHelpers {
	override get activeDocument(): Document {
		return activeDocument;
	}
}

export interface PublishComponents {
	api: PublishAPI;
	internal: PublishInternalAPI;
	file: PublishFileAPI;
}

export class PublishMetaBind extends MetaBind<PublishComponents> {
	settings: MetaBindPluginSettings;
	metadataManager: MetadataManager;
	mountableManager: MountableManager;

	constructor(settings: MetaBindPluginSettings) {
		super();
		this.settings = settings;
		this.domHelpers = new PublishDomHelpers();

		this.setComponents({
			api: new PublishAPI(this),
			internal: new PublishInternalAPI(this),
			file: new PublishFileAPI(this),
		});

		this.metadataManager = new MetadataManager();
		this.setUpMetadataManager();

		this.mountableManager = new MountableManager();

		this.load();
	}

	getSettings(): MetaBindPluginSettings {
		return this.settings;
	}

	saveSettings(settings: MetaBindPluginSettings): void {
		this.settings = settings;
	}

	setUpMetadataManager(): void {
		this.metadataManager.registerSource(
			new PublishMetadataSource(this, BindTargetStorageType.FRONTMATTER, this.metadataManager),
		);
		this.metadataManager.registerSource(
			new InternalMetadataSource(BindTargetStorageType.MEMORY, this.metadataManager),
		);
		this.metadataManager.registerSource(
			new GlobalMetadataSource(BindTargetStorageType.GLOBAL_MEMORY, this.metadataManager),
		);
		this.metadataManager.setDefaultSource(BindTargetStorageType.FRONTMATTER);

		// gated on outstanding metadata work, see `MetadataManager.hasCycleWork`
		this.metadataManager.setCycleScheduler(
			new IntervalCycleScheduler(() => void this.metadataManager.cycle(), this.settings.syncInterval),
		);
	}

	onLoad(): void {
		if (MB_DEBUG) console.log('meta-bind-publish | loaded');

		this.updateInternalSettings();

		publish.registerMarkdownPostProcessor((el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
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
				const mdrc = this.api.wrapInMDRC(mountable, codeBlock, ctx);

				mdrc.load();
			}
		}, 1);

		// "meta-bind" code blocks
		publish.registerMarkdownCodeBlockProcessor('meta-bind', (source, el, ctx) => {
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
				new PublishNotePosition(ctx, el),
			);
			const mdrc = this.api.wrapInMDRC(mountable, codeBlock, ctx);

			mdrc.load();
		});

		// "meta-bind-js-view" code blocks
		publish.registerMarkdownCodeBlockProcessor('meta-bind-js-view', (source, el, ctx) => {
			const mountable = this.api.createJsViewFieldMountable(ctx.sourcePath, {
				declaration: source,
			});

			const mdrc = this.api.wrapInMDRC(mountable, el, ctx);

			mdrc.load();
		});

		// "meta-bind-embed" code blocks
		publish.registerMarkdownCodeBlockProcessor('meta-bind-embed', (source, el, ctx) => {
			const mountable = this.api.createEmbedMountable(ctx.sourcePath, {
				content: source,
				depth: 0,
			});

			const mdrc = this.api.wrapInMDRC(mountable, el, ctx);

			mdrc.load();
		});

		for (let i = 1; i <= EMBED_MAX_DEPTH; i++) {
			publish.registerMarkdownCodeBlockProcessor(`meta-bind-embed-internal-${i}`, (source, el, ctx) => {
				const mountable = this.api.createEmbedMountable(ctx.sourcePath, {
					content: source,
					depth: i,
				});

				const mdrc = this.api.wrapInMDRC(mountable, el, ctx);

				mdrc.load();
			});
		}

		// "meta-bind-button" code blocks
		publish.registerMarkdownCodeBlockProcessor('meta-bind-button', (source, el, ctx) => {
			const mountable = this.api.createButtonMountable(ctx.sourcePath, {
				declaration: source,
				isPreview: false,
				position: new PublishNotePosition(ctx, el),
			});

			const mdrc = this.api.wrapInMDRC(mountable, el, ctx);

			mdrc.load();
		});
	}

	onUnload(): void {
		if (MB_DEBUG) console.log('meta-bind-publish | unloaded');
	}

	load(): void {
		this.onLoad();
	}

	unload(): void {
		this.onUnload();
	}

	updateInternalSettings(): void {
		setFirstWeekday(this.settings.firstWeekday);

		this.loadTemplates();
	}

	loadTemplates(): void {
		if (!this.api) {
			return;
		}

		const inputFieldTemplateParseErrorCollection = this.inputFieldParser.parseTemplates(
			this.settings.inputFieldTemplates,
		);
		if (inputFieldTemplateParseErrorCollection.hasErrors()) {
			console.warn('meta-bind | failed to parse input field templates', inputFieldTemplateParseErrorCollection);
		}

		const buttonTemplateParseErrorCollection = this.buttonManager.setButtonTemplates(this.settings.buttonTemplates);
		if (buttonTemplateParseErrorCollection.hasErrors()) {
			console.warn('meta-bind | failed to parse button templates', buttonTemplateParseErrorCollection);
		}
	}
}

// @ts-ignore
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
const mb = new PublishMetaBind(mb_settings);
// @ts-ignore

window.mb = mb;
