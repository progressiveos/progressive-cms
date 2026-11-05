import {
  type ApplicationServices,
  type CollectionFeedInput,
  type CollectionFeedItemRow,
  type CollectionFeedResult,
  queryCollectionFeedsBatch,
  queryPublishedCardRowsBounded,
} from "@pcms/api";
import { isStableId } from "@pcms/core";
import { resolveNavigationPaths } from "@pcms/routing";

export class MarkdownDependencyError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Request-local plan over the existing feed, quiz and routing loaders. */
export class MarkdownDiscoveryBatch {
  collecting = true;
  collectingMedia = false;
  readonly cardMediaIds = new Set<string>();
  readonly observedMediaIds = new Set<string>();
  assets(ids: readonly string[]) {
    if (this.collectingMedia) {
      for (const id of ids) this.observedMediaIds.add(id);
      if (ids.length > 256 || new Set([...this.cardMediaIds, ...ids]).size > 1500)
        throw new MarkdownDependencyError("media_dependency_limit");
      for (const id of ids) this.cardMediaIds.add(id);
    }
    return Promise.resolve(Object.fromEntries(ids.map((id) => [id, this.feedAssets[id] ?? null])));
  }

  feedAssets: Readonly<Record<string, import("@pcms/media").MediaAssetPublicViewModel | null>> = {};
  readonly quizzes = new Set<string>();
  private quizTitles: Readonly<Record<string, string>> = {};
  private quizUnavailable = false;
  private readonly feeds = new Map<
    string,
    { input: CollectionFeedInput; result?: CollectionFeedResult | null; reason?: string }
  >();
  private readonly pins = new Map<
    string,
    {
      ids: Set<string>;
      items?: readonly CollectionFeedItemRow[];
      excluded?: readonly string[];
      resolved?: Readonly<Record<string, string>>;
    }
  >();
  private readonly actions = new Map<string, Set<string>>();
  private readonly paths = new Map<string, ReadonlyMap<string, string>>();

  constructor(
    readonly application: ApplicationServices,
    readonly site: { id: string; title: string },
  ) {}

  async feed(input: CollectionFeedInput): Promise<CollectionFeedResult> {
    const key = JSON.stringify(input);
    if (this.collecting) {
      if (!this.feeds.has(key) && this.feeds.size === 32)
        throw new MarkdownDependencyError("collection_dependency_limit");
      this.feeds.set(key, { input });
      return {
        total: 0,
        page: input.page,
        pageSize: input.pageSize,
        pageCount: 1,
        tags: [],
        items: [],
      };
    }
    const result = this.feeds.get(key)?.result;
    if (!result)
      throw new MarkdownDependencyError(
        this.feeds.get(key)?.reason ?? "collection_dependency_limit",
      );
    return result;
  }

  async pinned(context: string, ids: readonly string[]): Promise<readonly CollectionFeedItemRow[]> {
    let source = this.pins.get(context);
    if (!source) {
      source = { ids: new Set() };
      this.pins.set(context, source);
    }
    if (this.collecting) {
      const admitted = new Set([...source.ids, ...ids.filter(isStableId)]);
      if (admitted.size > 1000) throw new MarkdownDependencyError("related_dependency_limit");
      source.ids = admitted;
      return [];
    }
    if (ids.some((id) => source.excluded?.includes(id)))
      throw new MarkdownDependencyError("related_dependency_limit");
    if (!source.items) throw new MarkdownDependencyError("related_dependency_unavailable");
    const byId = new Map(source.items?.map((row) => [row.entry_id, row]));
    return ids.flatMap((id) => {
      const resolved = source!.resolved?.[id];
      const row = resolved ? byId.get(resolved) : undefined;
      return row ? [row] : [];
    });
  }

  quizTitle(id: string): string | undefined {
    if (this.collecting) {
      if (this.quizzes.size >= 500 && !this.quizzes.has(id))
        throw new MarkdownDependencyError("quiz_dependency_limit");
      this.quizzes.add(id);
    }
    if (!this.collecting && this.quizUnavailable)
      throw new MarkdownDependencyError("quiz_dependency_unavailable");
    return this.quizTitles[id];
  }

  actionIds(locale: string, ids: readonly string[]): void {
    const group = new Set([...(this.actions.get(locale) ?? []), ...ids.filter(isStableId)]);
    if (group.size > 1000) throw new MarkdownDependencyError("action_dependency_limit");
    this.actions.set(locale, group);
  }

  actionPath(locale: string, id: string): string | null {
    return this.paths.get(locale)?.get(id) ?? null;
  }

  async load(): Promise<void> {
    const deps = {
      pool: this.application.pool,
      isKnownContentType: (key: string) =>
        this.application.contentTypes.getLatestContentType(key) !== null,
    };
    const feeds = [...this.feeds.values()];
    const tasks: Promise<unknown>[] = [
      queryCollectionFeedsBatch(
        deps,
        feeds.map((source) => source.input),
      ).then((results) => {
        results.forEach((result, index) => {
          feeds[index]!.result = result.result;
          feeds[index]!.reason = result.reason ?? "dependency_unavailable";
        });
      }),
      this.application.formsSource.domain.quizzes
        .getPublicTitles([...this.quizzes])
        .then((titles) => {
          this.quizTitles = titles;
        })
        .catch(() => {
          this.quizUnavailable = true;
        }),
    ];
    for (const [context, source] of this.pins) {
      tasks.push(
        queryPublishedCardRowsBounded(deps, {
          context,
          entryIds: [...source.ids],
          siteId: this.site.id,
        }).then((result) => {
          source.items = result.items;
          source.excluded = result.excludedEntryIds;
          source.resolved = result.resolvedEntryIds;
        }),
      );
    }
    for (const [locale, ids] of this.actions) {
      tasks.push(
        resolveNavigationPaths(this.application.pool, [...ids], { locale }).then((paths) => {
          this.paths.set(locale, paths);
        }),
      );
    }
    await Promise.allSettled(tasks);
    this.collecting = false;
  }
}
