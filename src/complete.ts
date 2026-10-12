/**
 * The `data-complete` hook on the kit's `CompleteButton` (`./react/ui`): `open` on the button that
 * completes, `undo` on the one that takes it back. Tests find the button by it, the portal's To-do
 * Done included (`runPortalTodo` in `./e2e`), so both sides import these instead of writing the
 * strings. React-free.
 */
export const COMPLETE_OPEN = 'open';
export const COMPLETE_UNDO = 'undo';

/** The selector for a CompleteButton in `state`. */
export const completeSelector = (state: typeof COMPLETE_OPEN | typeof COMPLETE_UNDO): string => `[data-complete="${state}"]`;
