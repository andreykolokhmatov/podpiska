ALTER TABLE "issues" ALTER COLUMN "number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_digests" ADD COLUMN "input_hash" text DEFAULT '' NOT NULL;