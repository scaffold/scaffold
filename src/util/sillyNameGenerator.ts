import { uniqueNamesGenerator } from '../../deps.ts';

export const generateSillyName = () =>
  uniqueNamesGenerator.uniqueNamesGenerator({
    dictionaries: [uniqueNamesGenerator.colors, uniqueNamesGenerator.animals],
    separator: '-',
  });
