import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { listAll } from "../repositories/category.repository.js";

/**
 * Public catalog taxonomy.
 *
 * The category list is reference data — the vocabulary a seller picks a
 * category from and a buyer browses by — so it ships without authentication,
 * exactly like the simulator's taxonomy install. Rows keep the simulator's
 * `Category` shape (`id`, `name`, `icon`, `image`, `parentId`, `order`) and the
 * order is deterministic: top-level categories by `order`, then each parent's
 * children by `order`, which is how a flat list renders as the same tree the
 * frontend builds from `parentId`.
 */

/** Wire shape of a category: `id` as a string, `parentId` as a string or null. */
const toCategoryDto = (category) => ({
    id: String(category._id),
    name: category.name,
    icon: category.icon ?? "",
    image: category.image ?? "",
    parentId: category.parentId ? String(category.parentId) : null,
    order: category.order ?? 0,
    createdAt: category.createdAt ? new Date(category.createdAt).toISOString() : null,
    updatedAt: category.updatedAt ? new Date(category.updatedAt).toISOString() : null
});

const categoryOrder = (categories) => {
    const top = categories.filter((entry) => entry.parentId === null).sort((a, b) => a.order - b.order);

    const childrenOf = new Map();
    for (const entry of categories) {
        if (entry.parentId === null) continue;
        const key = String(entry.parentId);
        if (!childrenOf.has(key)) childrenOf.set(key, []);
        childrenOf.get(key).push(entry);
    }

    const ordered = [];
    const used = new Set();
    for (const parent of top) {
        ordered.push(parent);
        used.add(String(parent.id));
        const children = (childrenOf.get(String(parent.id)) ?? []).sort((a, b) => a.order - b.order);
        ordered.push(...children);
        for (const child of children) used.add(String(child.id));
    }

    // A row whose parent is missing must still be served rather than dropped.
    for (const entry of categories) {
        if (!used.has(String(entry.id))) ordered.push(entry);
    }
    return ordered;
};

// GET /catalog/categories — public, no session required.
const listCategories = asyncHandlers(async (req, res) => {
    const rows = (await listAll()).map(toCategoryDto);

    return res.status(200).json(new ApiResponse(200, { categories: categoryOrder(rows) }, "Categories."));
});

export { listCategories, toCategoryDto, categoryOrder };
