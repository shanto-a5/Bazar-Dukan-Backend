import mongoose, { Schema } from "mongoose";

/**
 * A named atomic sequence, used to hand out the serial display name for
 * frictionless accounts (`Customer 1`, `Customer 2`, …).
 *
 * The document id *is* the sequence key, and `seq` is bumped with a single
 * `$inc` upsert, so two quick accounts created at the same instant can never
 * read the same number: one document, one atomic write. There is no schema-level
 * `_id` default because the key is meaningful to the caller.
 */
const counterSchema = new Schema(
    {
        _id: {
            type: String
        },
        seq: {
            type: Number,
            default: 0,
            min: 0
        }
    },
    { versionKey: false }
);

export const Counter = mongoose.model("Counter", counterSchema);
