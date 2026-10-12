import { Category } from "../models/category.model.js";

/**
 * Category data access.
 *
 * Categories are reference data: the whole tree is read for the public catalog
 * endpoint, and `upsert` is how the seed writes the simulator's taxonomy
 * without ever producing a second copy of the same row — the filter is the
 * category's own natural key (name within a parent), which is what makes
 * re-running `src/seed/seed.js` idempotent.
 */
const listAll = () => Category.find({});

const findById = (categoryId) => Category.findById(categoryId);

const upsert = (filter, update) =>
    Category.findOneAndUpdate(filter, { $set: update }, { new: true, upsert: true, runValidators: true });

export { listAll, findById, upsert };
