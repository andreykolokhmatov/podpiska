CREATE TABLE "channel_digests" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel_digests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"day" date NOT NULL,
	"summary_json" jsonb NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_digests_channel_id_day_unique" UNIQUE("channel_id","day")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channels_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"username" text NOT NULL,
	"title" text,
	"avatar_url" text,
	"last_fetched_at" timestamp with time zone,
	"is_available" boolean DEFAULT true NOT NULL,
	CONSTRAINT "channels_username_unique" UNIQUE("username"),
	CONSTRAINT "channels_username_lowercase" CHECK ("channels"."username" = lower("channels"."username"))
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"number" integer NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"content_json" jsonb,
	"error" text,
	"stats_json" jsonb,
	"digests_total" integer DEFAULT 0 NOT NULL,
	"digests_done" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issues_user_id_number_unique" UNIQUE("user_id","number"),
	CONSTRAINT "issues_status_check" CHECK ("status" in ('pending', 'collecting', 'digesting', 'composing', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "posts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"tg_post_id" integer NOT NULL,
	"text" text,
	"html" text,
	"published_at" timestamp with time zone NOT NULL,
	"views" integer,
	"has_media" boolean DEFAULT false NOT NULL,
	CONSTRAINT "posts_channel_id_tg_post_id_unique" UNIQUE("channel_id","tg_post_id")
);
--> statement-breakpoint
CREATE TABLE "user_channels" (
	"user_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_channels_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"telegram_id" bigint NOT NULL,
	"username" text,
	"first_name" text,
	"interests_prompt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_id_unique" UNIQUE("telegram_id")
);
--> statement-breakpoint
ALTER TABLE "channel_digests" ADD CONSTRAINT "channel_digests_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channels" ADD CONSTRAINT "user_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_channels" ADD CONSTRAINT "user_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_user_id_created_at_idx" ON "issues" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_channel_id_published_at_idx" ON "posts" USING btree ("channel_id","published_at");--> statement-breakpoint
CREATE INDEX "user_channels_channel_id_idx" ON "user_channels" USING btree ("channel_id");