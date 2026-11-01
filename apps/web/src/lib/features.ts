import {
  columnFilteringFeature,
  globalFilteringFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_datetime,
  tableFeatures,
} from "@tanstack/react-table";

export const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    datetime: sortFn_datetime,
  },
});

export type Features = typeof features;
