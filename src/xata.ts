// Generated by Xata Codegen 0.29.3. Please do not edit.
import { buildClient } from "@xata.io/client";
import type {
  BaseClientOptions,
  SchemaInference,
  XataRecord,
} from "@xata.io/client";

const tables = [
  {
    name: "skills",
    columns: [
      { name: "name", type: "string", unique: true },
      { name: "learned", type: "datetime" },
      { name: "years", type: "int", notNull: true, defaultValue: "0" },
      { name: "level", type: "int", notNull: true, defaultValue: "1" },
      { name: "isPublic", type: "bool", notNull: true, defaultValue: "false" },
      {
        name: "isFeatured",
        type: "bool",
        notNull: true,
        defaultValue: "false",
      },
      { name: "group", type: "string", defaultValue: "general" },
      { name: "notes", type: "text" },
      { name: "logo", type: "file", file: { defaultPublicAccess: true } },
      { name: "link", type: "string" },
    ],
  },
  {
    name: "projects",
    columns: [
      { name: "name", type: "string", unique: true },
      { name: "shortDescription", type: "text" },
      { name: "longDescription", type: "text" },
      { name: "client", type: "string" },
      { name: "role", type: "string" },
      { name: "started", type: "datetime" },
      { name: "ended", type: "datetime" },
      { name: "link", type: "string" },
      { name: "thumbnail", type: "file" },
      { name: "category", type: "string" },
      { name: "showLink", type: "bool", notNull: true, defaultValue: "false" },
      { name: "isCurrent", type: "bool", notNull: true, defaultValue: "false" },
      { name: "hasNotes", type: "bool", notNull: true, defaultValue: "false" },
      {
        name: "isFeatured",
        type: "bool",
        notNull: true,
        defaultValue: "false",
      },
      { name: "isPublic", type: "bool" },
      { name: "slug", type: "string", unique: true },
      { name: "group", type: "string" },
      {
        name: "images",
        type: "file[]",
        "file[]": { defaultPublicAccess: true },
      },
      { name: "skills", type: "multiple" },
    ],
  },
  {
    name: "articles",
    columns: [
      { name: "title", type: "string", unique: true },
      { name: "slug", type: "string", unique: true },
      { name: "aboveFold", type: "text" },
      { name: "content", type: "text" },
      { name: "tags", type: "multiple" },
      { name: "category", type: "string" },
    ],
  },
  {
    name: "details",
    columns: [
      { name: "group", type: "string" },
      { name: "content", type: "string" },
      { name: "icon", type: "string" },
      { name: "label", type: "string", unique: true },
      { name: "link", type: "string" },
    ],
  },
  {
    name: "schools",
    columns: [
      { name: "name", type: "string", unique: true },
      { name: "gpa", type: "float", notNull: true, defaultValue: "4.0" },
      { name: "gpaMax", type: "float", notNull: true, defaultValue: "4.0" },
      { name: "start", type: "datetime" },
      { name: "end", type: "datetime" },
      { name: "degree", type: "string" },
      { name: "major", type: "string" },
      { name: "minor", type: "string" },
      { name: "honors", type: "string" },
      { name: "isCurrent", type: "bool", notNull: true, defaultValue: "false" },
      { name: "isPublic", type: "bool", notNull: true, defaultValue: "false" },
      { name: "notes", type: "text" },
      { name: "link", type: "string" },
      { name: "logo", type: "file" },
    ],
  },
  {
    name: "content",
    columns: [
      { name: "slug", type: "string", unique: true },
      { name: "body", type: "text" },
      { name: "isPublic", type: "bool", notNull: true, defaultValue: "false" },
      { name: "group", type: "string", notNull: true, defaultValue: "unset" },
    ],
  },
] as const;

export type SchemaTables = typeof tables;
export type InferredTypes = SchemaInference<SchemaTables>;

export type Skills = InferredTypes["skills"];
export type SkillsRecord = Skills & XataRecord;

export type Projects = InferredTypes["projects"];
export type ProjectsRecord = Projects & XataRecord;

export type Articles = InferredTypes["articles"];
export type ArticlesRecord = Articles & XataRecord;

export type Details = InferredTypes["details"];
export type DetailsRecord = Details & XataRecord;

export type Schools = InferredTypes["schools"];
export type SchoolsRecord = Schools & XataRecord;

export type Content = InferredTypes["content"];
export type ContentRecord = Content & XataRecord;

export type DatabaseSchema = {
  skills: SkillsRecord;
  projects: ProjectsRecord;
  articles: ArticlesRecord;
  details: DetailsRecord;
  schools: SchoolsRecord;
  content: ContentRecord;
};

const DatabaseClient = buildClient();

const defaultOptions = {
  databaseURL: "https://Personal-pk6f8v.us-east-1.xata.sh/db/corbin",
};

export class XataClient extends DatabaseClient<DatabaseSchema> {
  constructor(options?: BaseClientOptions) {
    super({ ...defaultOptions, ...options }, tables);
  }
}

let instance: XataClient | undefined = undefined;

export const getXataClient = () => {
  if (instance) return instance;

  instance = new XataClient();
  return instance;
};
