import { uniqueNamesGenerator } from '../../deps.ts';
import { EntropyProvider } from '../Config.ts';

export const generateSillyName = (entropyProvider: EntropyProvider) =>
  uniqueNamesGenerator.uniqueNamesGenerator({
    dictionaries: [uniqueNamesGenerator.colors, uniqueNamesGenerator.animals],
    separator: '-',
    seed: Math.floor(entropyProvider.randomNumber() * (2 ** 32)),
  });
