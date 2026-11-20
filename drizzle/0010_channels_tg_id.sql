ALTER TABLE "channels" ADD COLUMN "tg_id" bigint;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_tg_id_unique" UNIQUE("tg_id");