/** Only the parts of FHIR R4 the app reads; everything else is ignored (never invented). */
export interface Coding {
  system?: string;
  code?: string;
  display?: string;
}

export interface Observation {
  resourceType: "Observation";
  id?: string;
  status?: string;
  meta?: { lastUpdated?: string; source?: string; tag?: Array<{ system?: string; code?: string; display?: string }> };
  code?: { coding?: Coding[] };
  subject?: { reference?: string };
  effectiveDateTime?: string;
  effectivePeriod?: { start?: string; end?: string };
  issued?: string;
  valueQuantity?: { value?: number; unit?: string; system?: string; code?: string };
  device?: { reference?: string };
}

export interface Patient {
  resourceType: "Patient";
  id?: string;
  identifier?: { system?: string; value?: string }[];
  name?: { family?: string; given?: string[]; text?: string }[];
  birthDate?: string;
  gender?: string;
}

export interface Bundle<T> {
  resourceType: "Bundle";
  total?: number;
  entry?: { resource?: T }[];
  link?: { relation?: string; url?: string }[];
}
