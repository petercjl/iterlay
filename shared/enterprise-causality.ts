/** Retains our own causal predecessors until the UI has observed their durable revision. */
export class BoardSaveCausality {
  private boards = new Map<string, { epoch: string; updates: Map<string, number | undefined> }>();
  record(id: string, epoch: string, update: string, confirmedRevision?: number): boolean {
    let board = this.boards.get(id);
    if (!board || board.epoch !== epoch) { board = { epoch, updates: new Map() }; this.boards.set(id, board); }
    const added = !board.updates.has(update);
    board.updates.set(update, confirmedRevision ?? board.updates.get(update));
    return added;
  }
  prior(id: string, epoch: string, observedRevision: number | undefined): string[] {
    const board = this.boards.get(id);
    if (!board || board.epoch !== epoch) return [];
    for (const [update, revision] of board.updates) {
      if (revision !== undefined && observedRevision !== undefined && revision <= observedRevision) board.updates.delete(update);
    }
    return [...board.updates.keys()];
  }
  forget(id: string) { this.boards.delete(id); }
  clear() { this.boards.clear(); }
}
