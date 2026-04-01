// =====================================================
// Citation Format Presets for Bibliography Editor
// =====================================================

export interface CitationField {
  key: string;
  label: string;
  required: boolean;
  placeholder?: string;
  helpText?: string;
}

export interface SourceTypeVariant {
  key: string;
  label: string;
  options: { value: string; label: string }[];
}

export interface SourceTypeDefinition {
  id: string;
  label: string;
  fields: CitationField[];
  variants?: SourceTypeVariant[];
}

export interface CitationFormat {
  id: string;
  label: string;
  numbered: boolean;
  sourceTypes: SourceTypeDefinition[];
  formatEntry(sourceType: string, fields: Record<string, string>, variants?: Record<string, string>): string;
}

// ── Common field builders ──

const authorField = (placeholder = "Last, F. M."): CitationField =>
  ({ key: "author", label: "Author(s)", required: true, placeholder, helpText: "Separate multiple authors with &" });
const yearField: CitationField = { key: "year", label: "Year", required: true, placeholder: "2024" };
const titleField = (help = ""): CitationField =>
  ({ key: "title", label: "Title", required: true, placeholder: "Title of work", helpText: help });
const publisherField: CitationField = { key: "publisher", label: "Publisher", required: true, placeholder: "Publisher Name" };
const doiUrlField: CitationField = { key: "doi", label: "DOI / URL", required: false, placeholder: "https://doi.org/..." };
const editionField: CitationField = { key: "edition", label: "Edition", required: false, placeholder: "2nd ed." };
const journalField = (help = ""): CitationField =>
  ({ key: "journal", label: "Journal Name", required: true, placeholder: "Journal of Example Studies", helpText: help });
const volumeField: CitationField = { key: "volume", label: "Volume", required: true, placeholder: "45" };
const issueField: CitationField = { key: "issue", label: "Issue", required: true, placeholder: "2" };
const pagesField: CitationField = { key: "pages", label: "Pages", required: true, placeholder: "123-145" };
const urlField: CitationField = { key: "url", label: "URL", required: true, placeholder: "https://..." };
const accessDateField: CitationField = { key: "accessDate", label: "Access Date", required: false, placeholder: "March 30, 2026" };
const siteNameField: CitationField = { key: "siteName", label: "Site Name", required: true, placeholder: "Website Name" };
const pageTitleField: CitationField = { key: "pageTitle", label: "Page Title", required: true, placeholder: "Title of page" };
const confNameField: CitationField = { key: "confName", label: "Conference Name", required: true, placeholder: "Proc. of the International Conf. on..." };
const locationField: CitationField = { key: "location", label: "Location", required: true, placeholder: "City, State/Country" };
const universityField: CitationField = { key: "university", label: "University", required: true, placeholder: "University Name" };
const dateField = (label = "Date"): CitationField => ({ key: "date", label, required: true, placeholder: "Month Day, Year" });
const chapterTitleField: CitationField = { key: "chapterTitle", label: "Chapter Title", required: true, placeholder: "Title of chapter" };
const editorField: CitationField = { key: "editor", label: "Editor(s)", required: true, placeholder: "Last, F. M." };
const bookTitleField: CitationField = { key: "bookTitle", label: "Book Title", required: true, placeholder: "Title of book" };

const thesisVariant: SourceTypeVariant = {
  key: "thesisType", label: "Type",
  options: [
    { value: "phd", label: "Doctoral dissertation" },
    { value: "masters", label: "Master's thesis" },
  ],
};

const confVariant: SourceTypeVariant = {
  key: "confType", label: "Publication Status",
  options: [
    { value: "published", label: "Published proceedings" },
    { value: "unpublished", label: "Unpublished presentation" },
  ],
};

// ── Helper for formatting ──

function italic(text: string): string { return text ? `_${text}_` : ""; }
function quoted(text: string): string { return text ? `"${text}"` : ""; }
function paren(text: string): string { return text ? `(${text})` : ""; }
function addDot(text: string): string { return text && !text.endsWith(".") ? text + "." : text; }
function thesisLabel(variants?: Record<string, string>): string {
  return variants?.thesisType === "masters" ? "Master's thesis" : "Doctoral dissertation";
}

// =====================================================
// APA 7th Edition
// =====================================================

const apa7: CitationFormat = {
  id: "apa7", label: "APA 7th Edition", numbered: false,
  sourceTypes: [
    {
      id: "book", label: "Book",
      fields: [authorField(), yearField, titleField("Sentence case, italicized"), editionField, publisherField, doiUrlField],
    },
    {
      id: "journal", label: "Journal Article",
      fields: [authorField(), yearField, { key: "articleTitle", label: "Article Title", required: true, placeholder: "Title of article" }, journalField("Title case"), volumeField, issueField, pagesField, doiUrlField],
    },
    {
      id: "website", label: "Website",
      fields: [authorField("Author or Organization"), dateField("Date"), pageTitleField, { ...siteNameField, required: false }, urlField, { ...accessDateField, helpText: "Only if content may change" }],
    },
    {
      id: "conference", label: "Conference Paper",
      fields: [authorField(), dateField("Year, Month"), { key: "paperTitle", label: "Paper Title", required: true, placeholder: "Title of paper" }, confNameField, locationField, doiUrlField],
      variants: [confVariant],
    },
    {
      id: "thesis", label: "Thesis / Dissertation",
      fields: [authorField(), yearField, titleField("Italicized"), universityField, doiUrlField],
      variants: [thesisVariant],
    },
    {
      id: "chapter", label: "Book Chapter",
      fields: [authorField(), yearField, chapterTitleField, editorField, bookTitleField, pagesField, publisherField, doiUrlField],
    },
  ],
  formatEntry(sourceType, f, v) {
    switch (sourceType) {
      case "book": {
        const ed = f.edition ? ` (${f.edition})` : "";
        return `${addDot(f.author)} ${paren(f.year)}. ${italic(f.title)}${ed}. ${addDot(f.publisher)}${f.doi ? " " + f.doi : ""}`;
      }
      case "journal":
        return `${addDot(f.author)} ${paren(f.year)}. ${addDot(f.articleTitle)} ${italic(f.journal)}, ${italic(f.volume)}(${f.issue}), ${f.pages}.${f.doi ? " " + f.doi : ""}`;
      case "website": {
        const site = f.siteName ? ` ${f.siteName}.` : "";
        return `${addDot(f.author)} ${paren(f.date)}. ${italic(f.pageTitle)}.${site} ${f.url}`;
      }
      case "conference":
        return `${addDot(f.author)} ${paren(f.date)}. ${addDot(f.paperTitle)} ${f.confName}, ${f.location}.${f.doi ? " " + f.doi : ""}`;
      case "thesis": {
        const type = thesisLabel(v);
        return `${addDot(f.author)} ${paren(f.year)}. ${italic(f.title)} [${type}, ${f.university}].${f.doi ? " " + f.doi : ""}`;
      }
      case "chapter":
        return `${addDot(f.author)} ${paren(f.year)}. ${addDot(f.chapterTitle)} In ${f.editor} (Ed.), ${italic(f.bookTitle)} (pp. ${f.pages}). ${addDot(f.publisher)}${f.doi ? " " + f.doi : ""}`;
      default: return "";
    }
  },
};

// =====================================================
// MLA 9th Edition
// =====================================================

const mla9: CitationFormat = {
  id: "mla9", label: "MLA 9th Edition", numbered: false,
  sourceTypes: [
    {
      id: "book", label: "Book",
      fields: [authorField("Last, First."), titleField("Title case, italicized"), editionField, publisherField, yearField, doiUrlField],
    },
    {
      id: "journal", label: "Journal Article",
      fields: [authorField("Last, First."), { key: "articleTitle", label: "Article Title", required: true, placeholder: "\"Title of Article\"" }, journalField(), volumeField, issueField, dateField("Date"), pagesField, doiUrlField],
    },
    {
      id: "website", label: "Website",
      fields: [{ ...authorField("Last, First."), required: false }, pageTitleField, siteNameField, dateField("Date"), urlField, accessDateField],
    },
    {
      id: "conference", label: "Conference Paper",
      fields: [authorField("Last, First."), { key: "paperTitle", label: "Paper Title", required: true, placeholder: "\"Title of Paper\"" }, confNameField, dateField("Date"), locationField],
      variants: [confVariant],
    },
    {
      id: "thesis", label: "Thesis / Dissertation",
      fields: [authorField("Last, First."), titleField("Italicized"), yearField, universityField, doiUrlField],
      variants: [thesisVariant],
    },
    {
      id: "chapter", label: "Book Chapter",
      fields: [authorField("Last, First."), chapterTitleField, editorField, bookTitleField, publisherField, yearField, pagesField],
    },
  ],
  formatEntry(sourceType, f, v) {
    switch (sourceType) {
      case "book": {
        const ed = f.edition ? ` ${f.edition},` : "";
        return `${addDot(f.author)} ${italic(f.title)}.${ed} ${f.publisher}, ${f.year}.${f.doi ? " " + f.doi : ""}`;
      }
      case "journal":
        return `${addDot(f.author)} ${quoted(f.articleTitle)}. ${italic(f.journal)}, vol. ${f.volume}, no. ${f.issue}, ${f.date}, pp. ${f.pages}.${f.doi ? " " + f.doi : ""}`;
      case "website": {
        const auth = f.author ? `${addDot(f.author)} ` : "";
        return `${auth}${quoted(f.pageTitle)}. ${italic(f.siteName)}, ${f.date}, ${f.url}.`;
      }
      case "conference":
        return `${addDot(f.author)} ${quoted(f.paperTitle)}. ${italic(f.confName)}, ${f.date}, ${f.location}.`;
      case "thesis": {
        const type = thesisLabel(v);
        return `${addDot(f.author)} ${italic(f.title)}. ${f.year}. ${f.university}. ${type}.${f.doi ? " " + f.doi : ""}`;
      }
      case "chapter":
        return `${addDot(f.author)} ${quoted(f.chapterTitle)}. ${italic(f.bookTitle)}, edited by ${f.editor}, ${f.publisher}, ${f.year}, pp. ${f.pages}.`;
      default: return "";
    }
  },
};

// =====================================================
// AMA 11th Edition
// =====================================================

const ama11: CitationFormat = {
  id: "ama11", label: "AMA 11th Edition", numbered: true,
  sourceTypes: [
    {
      id: "book", label: "Book",
      fields: [authorField("Last AB"), titleField("Italicized"), editionField, publisherField, yearField, doiUrlField],
    },
    {
      id: "journal", label: "Journal Article",
      fields: [authorField("Last AB"), { key: "articleTitle", label: "Article Title", required: true, placeholder: "Title of article" }, journalField("NLM abbreviated, italicized"), yearField, volumeField, issueField, pagesField, { ...doiUrlField, placeholder: "doi:10.xxxx/xxxxx" }],
    },
    {
      id: "website", label: "Website",
      fields: [authorField("Last AB or Organization"), pageTitleField, siteNameField, dateField("Published/Updated Date"), { ...accessDateField, required: true }, urlField],
    },
    {
      id: "thesis", label: "Thesis / Dissertation",
      fields: [authorField("Last AB"), titleField("Italicized"), { ...locationField, label: "City: Institution", placeholder: "City: University" }, yearField],
      variants: [thesisVariant],
    },
  ],
  formatEntry(sourceType, f, v) {
    switch (sourceType) {
      case "book": {
        const ed = f.edition ? ` ${f.edition}.` : "";
        return `${addDot(f.author)} ${italic(f.title)}.${ed} ${f.publisher}; ${f.year}.${f.doi ? " " + f.doi : ""}`;
      }
      case "journal":
        return `${addDot(f.author)} ${addDot(f.articleTitle)} ${italic(f.journal)}. ${f.year};${f.volume}(${f.issue}):${f.pages}.${f.doi ? " " + f.doi : ""}`;
      case "website":
        return `${addDot(f.author)} ${addDot(f.pageTitle)} ${addDot(f.siteName)} Published ${f.date}. Accessed ${f.accessDate}. ${f.url}`;
      case "thesis": {
        const type = thesisLabel(v);
        return `${addDot(f.author)} ${italic(f.title)}. ${type}. ${f.location}; ${f.year}.`;
      }
      default: return "";
    }
  },
};

// =====================================================
// Chicago — Notes-Bibliography
// =====================================================

const chicagoNB: CitationFormat = {
  id: "chicago-nb", label: "Chicago (Notes-Bibliography)", numbered: false,
  sourceTypes: [
    {
      id: "book", label: "Book",
      fields: [authorField("Last, First."), titleField("Italicized"), { ...locationField, label: "Place of Publication" }, publisherField, yearField, doiUrlField],
    },
    {
      id: "journal", label: "Journal Article",
      fields: [authorField("Last, First."), { key: "articleTitle", label: "Article Title", required: true, placeholder: "\"Title of Article\"" }, journalField(), volumeField, issueField, yearField, pagesField, doiUrlField],
    },
    {
      id: "website", label: "Website",
      fields: [authorField("Last, First."), pageTitleField, siteNameField, dateField("Date"), urlField, accessDateField],
    },
    {
      id: "thesis", label: "Thesis / Dissertation",
      fields: [authorField("Last, First."), titleField("In quotation marks"), universityField, yearField],
      variants: [thesisVariant],
    },
  ],
  formatEntry(sourceType, f, v) {
    switch (sourceType) {
      case "book":
        return `${addDot(f.author)} ${italic(f.title)}. ${f.location}: ${f.publisher}, ${f.year}.${f.doi ? " " + f.doi : ""}`;
      case "journal":
        return `${addDot(f.author)} ${quoted(f.articleTitle)}. ${italic(f.journal)} ${f.volume}, no. ${f.issue} (${f.year}): ${f.pages}.${f.doi ? " " + f.doi : ""}`;
      case "website":
        return `${addDot(f.author)} ${quoted(f.pageTitle)}. ${f.siteName}. ${f.date}. ${f.url}.`;
      case "thesis": {
        const type = v?.thesisType === "masters" ? "MA thesis" : "PhD diss.";
        return `${addDot(f.author)} ${quoted(f.title)}. ${type}, ${f.university}, ${f.year}.`;
      }
      default: return "";
    }
  },
};

// =====================================================
// Chicago — Author-Date
// =====================================================

const chicagoAD: CitationFormat = {
  id: "chicago-ad", label: "Chicago (Author-Date)", numbered: false,
  sourceTypes: chicagoNB.sourceTypes, // same fields
  formatEntry(sourceType, f, v) {
    switch (sourceType) {
      case "book":
        return `${addDot(f.author)} ${f.year}. ${italic(f.title)}. ${f.location}: ${addDot(f.publisher)}${f.doi ? " " + f.doi : ""}`;
      case "journal":
        return `${addDot(f.author)} ${f.year}. ${quoted(f.articleTitle)}. ${italic(f.journal)} ${f.volume} (${f.issue}): ${f.pages}.${f.doi ? " " + f.doi : ""}`;
      case "website":
        return `${addDot(f.author)} ${f.year}. ${quoted(f.pageTitle)}. ${f.siteName}. ${f.date}. ${f.url}.`;
      case "thesis": {
        const type = v?.thesisType === "masters" ? "MA thesis" : "PhD diss.";
        return `${addDot(f.author)} ${f.year}. ${quoted(f.title)}. ${type}, ${addDot(f.university)}`;
      }
      default: return "";
    }
  },
};

// =====================================================
// Turabian 9th Edition
// =====================================================

const turabian: CitationFormat = {
  id: "turabian", label: "Turabian 9th Edition", numbered: false,
  sourceTypes: chicagoNB.sourceTypes, // mirrors Chicago
  formatEntry: chicagoNB.formatEntry, // same formatting
};

// =====================================================
// IEEE
// =====================================================

const ieee: CitationFormat = {
  id: "ieee", label: "IEEE", numbered: true,
  sourceTypes: [
    {
      id: "book", label: "Book",
      fields: [authorField("F. M. Last"), titleField("Italicized"), editionField, { ...locationField, label: "City, State/Country" }, publisherField, yearField, doiUrlField],
    },
    {
      id: "journal", label: "Journal Article",
      fields: [authorField("F. M. Last"), { key: "articleTitle", label: "Article Title", required: true, placeholder: "Title of article" }, journalField("IEEE abbreviated, italicized"), volumeField, issueField, pagesField, dateField("Month Year"), doiUrlField],
    },
    {
      id: "website", label: "Website",
      fields: [authorField("F. M. Last or Organization"), pageTitleField, siteNameField, { ...accessDateField, required: true }, urlField],
    },
    {
      id: "conference", label: "Conference Paper",
      fields: [authorField("F. M. Last"), { key: "paperTitle", label: "Paper Title", required: true, placeholder: "Title of paper" }, confNameField, { ...locationField, label: "City, Country" }, yearField, pagesField],
    },
    {
      id: "thesis", label: "Thesis / Dissertation",
      fields: [authorField("F. M. Last"), titleField("In quotation marks"), { key: "dept", label: "Dept., University", required: true, placeholder: "Dept. of CS, MIT" }, { ...locationField, label: "City, State/Country" }, yearField],
      variants: [thesisVariant],
    },
  ],
  formatEntry(sourceType, f, v) {
    switch (sourceType) {
      case "book": {
        const ed = f.edition ? `, ${f.edition}` : "";
        return `${f.author}, ${italic(f.title)}${ed}. ${f.location}: ${f.publisher}, ${f.year}.${f.doi ? " doi: " + f.doi : ""}`;
      }
      case "journal":
        return `${f.author}, ${quoted(f.articleTitle)}, ${italic(f.journal)}, vol. ${f.volume}, no. ${f.issue}, pp. ${f.pages}, ${f.date}.${f.doi ? " doi: " + f.doi : ""}`;
      case "website":
        return `${f.author}, ${quoted(f.pageTitle)}, ${italic(f.siteName)}. Accessed: ${f.accessDate}. [Online]. Available: ${f.url}`;
      case "conference":
        return `${f.author}, ${quoted(f.paperTitle)}, in ${italic(f.confName)}, ${f.location}, ${f.year}, pp. ${f.pages}.`;
      case "thesis": {
        const type = v?.thesisType === "masters" ? "M.S. thesis" : "Ph.D. dissertation";
        return `${f.author}, ${quoted(f.title)}, ${type}, ${f.dept}, ${f.location}, ${f.year}.`;
      }
      default: return "";
    }
  },
};

// =====================================================
// Vancouver (ICMJE / NLM)
// =====================================================

const vancouver: CitationFormat = {
  id: "vancouver", label: "Vancouver/NLM", numbered: true,
  sourceTypes: [
    {
      id: "book", label: "Book",
      fields: [authorField("Last AB"), titleField(), editionField, { ...locationField, label: "Place" }, publisherField, yearField],
    },
    {
      id: "journal", label: "Journal Article",
      fields: [authorField("Last AB"), { key: "articleTitle", label: "Article Title", required: true, placeholder: "Title of article" }, journalField("NLM abbreviated"), { ...dateField("Year Month"), placeholder: "2024 Mar" }, volumeField, issueField, pagesField, doiUrlField],
    },
    {
      id: "website", label: "Website",
      fields: [authorField("Last AB or Organization"), { ...pageTitleField, helpText: "Followed by [Internet]" }, { ...locationField, label: "Place: Publisher" }, dateField("Date [updated; cited]"), urlField],
    },
    {
      id: "thesis", label: "Thesis / Dissertation",
      fields: [authorField("Last AB"), { ...titleField(), helpText: "Followed by [dissertation] or [master's thesis]" }, { ...locationField, label: "City: University" }, yearField],
      variants: [thesisVariant],
    },
  ],
  formatEntry(sourceType, f, v) {
    switch (sourceType) {
      case "book": {
        const ed = f.edition ? ` ${f.edition}.` : "";
        return `${addDot(f.author)} ${addDot(f.title)}${ed} ${f.location}: ${f.publisher}; ${f.year}.`;
      }
      case "journal":
        return `${addDot(f.author)} ${addDot(f.articleTitle)} ${f.journal}. ${f.date};${f.volume}(${f.issue}):${f.pages}.${f.doi ? " " + f.doi : ""}`;
      case "website":
        return `${addDot(f.author)} ${f.pageTitle} [Internet]. ${f.location}; ${f.date}. Available from: ${f.url}`;
      case "thesis": {
        const type = v?.thesisType === "masters" ? "[master's thesis]" : "[dissertation]";
        return `${addDot(f.author)} ${f.title} ${type}. ${f.location}; ${f.year}.`;
      }
      default: return "";
    }
  },
};

// =====================================================
// Harvard (Author-Date)
// =====================================================

const harvard: CitationFormat = {
  id: "harvard", label: "Harvard", numbered: false,
  sourceTypes: [
    {
      id: "book", label: "Book",
      fields: [authorField("Last, F.M."), yearField, titleField("Italicized"), editionField, { ...locationField, label: "Place" }, publisherField],
    },
    {
      id: "journal", label: "Journal Article",
      fields: [authorField("Last, F.M."), yearField, { key: "articleTitle", label: "Article Title", required: true, placeholder: "Title of article" }, journalField("Italicized"), { key: "volIssue", label: "Volume(Issue)", required: true, placeholder: "45(2)" }, pagesField, doiUrlField],
    },
    {
      id: "website", label: "Website",
      fields: [authorField("Last, F.M. or Organization"), yearField, pageTitleField, urlField, { ...accessDateField, required: true, placeholder: "Accessed 30 March 2026" }],
    },
    {
      id: "thesis", label: "Thesis / Dissertation",
      fields: [authorField("Last, F.M."), yearField, titleField("Italicized"), universityField],
      variants: [thesisVariant],
    },
  ],
  formatEntry(sourceType, f, v) {
    switch (sourceType) {
      case "book": {
        const ed = f.edition ? ` ${f.edition}.` : "";
        return `${f.author} ${f.year}. ${italic(f.title)}.${ed} ${f.location}: ${addDot(f.publisher)}`;
      }
      case "journal":
        return `${f.author} ${f.year}. ${addDot(f.articleTitle)} ${italic(f.journal)}, ${f.volIssue}, pp. ${f.pages}.${f.doi ? " " + f.doi : ""}`;
      case "website":
        return `${f.author} ${f.year}. ${italic(f.pageTitle)}. [online] Available at: ${f.url} [${f.accessDate}].`;
      case "thesis": {
        const type = v?.thesisType === "masters" ? "Masters dissertation" : "PhD thesis";
        return `${f.author} ${f.year}. ${italic(f.title)}. ${type}. ${addDot(f.university)}`;
      }
      default: return "";
    }
  },
};

// =====================================================
// ASA 6th Edition
// =====================================================

const asa6: CitationFormat = {
  id: "asa6", label: "ASA 6th Edition", numbered: false,
  sourceTypes: [
    {
      id: "book", label: "Book",
      fields: [authorField("Last, First."), yearField, titleField("Italicized, title case"), { ...locationField, label: "City, ST" }, publisherField, doiUrlField],
    },
    {
      id: "journal", label: "Journal Article",
      fields: [authorField("Last, First."), yearField, { key: "articleTitle", label: "Article Title", required: true, placeholder: "\"Title of Article\"" }, journalField("Italicized"), { key: "volIssue", label: "Volume(Issue)", required: true, placeholder: "88(2)" }, pagesField, doiUrlField],
    },
    {
      id: "website", label: "Website",
      fields: [authorField("Last, First. or Organization"), yearField, pageTitleField, { ...accessDateField, label: "Retrieved Date", required: true }, urlField],
    },
    {
      id: "thesis", label: "Thesis / Dissertation",
      fields: [authorField("Last, First."), yearField, titleField("In quotation marks"), { key: "dept", label: "Department, University", required: true, placeholder: "Dept. of Sociology, University" }, locationField],
      variants: [thesisVariant],
    },
  ],
  formatEntry(sourceType, f, v) {
    switch (sourceType) {
      case "book":
        return `${addDot(f.author)} ${f.year}. ${italic(f.title)}. ${f.location}: ${addDot(f.publisher)}${f.doi ? " " + f.doi : ""}`;
      case "journal":
        return `${addDot(f.author)} ${f.year}. ${quoted(f.articleTitle)}. ${italic(f.journal)} ${f.volIssue}:${f.pages}.${f.doi ? " doi:" + f.doi : ""}`;
      case "website":
        return `${addDot(f.author)} ${f.year}. ${quoted(f.pageTitle)}. Retrieved ${f.accessDate} (${f.url}).`;
      case "thesis": {
        const type = v?.thesisType === "masters" ? "MA thesis" : "PhD dissertation";
        return `${addDot(f.author)} ${f.year}. ${quoted(f.title)}. ${type}, ${f.dept}, ${f.location}.`;
      }
      default: return "";
    }
  },
};

// =====================================================
// Exported format list
// =====================================================

export const CITATION_FORMATS: CitationFormat[] = [
  apa7, mla9, ama11, chicagoNB, chicagoAD, turabian, ieee, vancouver, harvard, asa6,
];

// ── Auto-generate anchor ID from author + year ──

export function generateAnchorId(author: string, year: string, existingIds: Set<string>): string {
  const lastName = (author.split(",")[0] || author.split(" ")[0] || "ref").trim().toLowerCase().replace(/[^a-z]/g, "");
  const base = `${lastName}${year || "nd"}`;
  if (!existingIds.has(base)) return base;
  for (let i = 0; i < 26; i++) {
    const candidate = base + String.fromCharCode(97 + i); // a, b, c...
    if (!existingIds.has(candidate)) return candidate;
  }
  return base + Date.now();
}
