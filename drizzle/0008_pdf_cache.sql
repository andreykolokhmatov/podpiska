ALTER TABLE "issues" ADD COLUMN "pdf_file_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "pdf_file_bot" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pdf_sends_day" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pdf_sends_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_pdf_file_bot_check" CHECK ("pdf_file_bot" in ('prod', 'dev'));