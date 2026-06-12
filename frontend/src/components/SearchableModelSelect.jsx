import Select from 'react-select';

/**
 * Searchable model selector using react-select.
 * Provides type-to-filter functionality for large model lists.
 */
export default function SearchableModelSelect({
  models,
  value,
  onChange,
  placeholder = "Search and select a model...",
  isDisabled = false,
  isLoading = false,
  allModels = null, // Optional: all models to find current value if filtered out
}) {
  // Convert models to react-select format with grouping
  const groupedOptions = models.reduce((acc, model) => {
    // Determine group label
    let groupLabel;
    // Use source field if available, otherwise fallback to provider check
    const isOpenRouter = model.source === 'openrouter' || model.provider === 'OpenRouter';
    const isOllama = model.id?.startsWith('ollama:') || model.provider === 'Ollama';

    if (isOpenRouter) {
      groupLabel = 'OpenRouter (Cloud)';
    } else if (isOllama) {
      groupLabel = 'Local (Ollama)';
    } else {
      groupLabel = `${model.provider || 'Direct'} (Direct)`;
    }

    if (!acc[groupLabel]) {
      acc[groupLabel] = [];
    }
    acc[groupLabel].push({
      value: model.id,
      label: model.name,
      model: model, // Keep full model data for reference
    });
    return acc;
  }, {});

  // Convert to react-select grouped format
  const providerOrder = [
    'OpenAI (Direct)', 'Anthropic (Direct)', 'Google (Direct)', 'Mistral (Direct)', 'DeepSeek (Direct)',
    'Groq (Direct)',
    'OpenRouter (Cloud)',
    'Local (Ollama)'
  ];

  const options = Object.keys(groupedOptions)
    .sort((a, b) => {
      const indexA = providerOrder.indexOf(a);
      const indexB = providerOrder.indexOf(b);
      if (indexA !== -1 && indexB !== -1) return indexA - indexB;
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;
      return a.localeCompare(b);
    })
    .map(group => ({
      label: group,
      options: groupedOptions[group],
    }));

  // Find current value in options
  let selectedOption = options
    .flatMap(group => group.options)
    .find(opt => opt.value === value) || null;

  // If current value not found in filtered options, try to find it in allModels
  // This keeps the selection visible even when filtered out
  if (!selectedOption && value && allModels) {
    const currentModel = allModels.find(m => m.id === value);
    if (currentModel) {
      selectedOption = {
        value: currentModel.id,
        label: `${currentModel.name} (filtered)`,
        model: currentModel,
      };
    }
  }

  // Custom styles to match the Escher-coffee theme
  const customStyles = {
    control: (base, state) => ({
      ...base,
      backgroundColor: 'rgba(36, 26, 16, 0.8)',
      borderColor: state.isFocused ? '#d4913c' : 'rgba(212, 145, 60, 0.2)',
      borderRadius: '4px',
      minHeight: '38px',
      boxShadow: state.isFocused ? '0 0 0 2px rgba(212, 145, 60, 0.3)' : 'none',
      '&:hover': {
        borderColor: '#d4913c',
      },
    }),
    menu: (base) => ({
      ...base,
      backgroundColor: 'rgba(26, 19, 12, 0.98)',
      borderRadius: '4px',
      border: '1px solid rgba(212, 145, 60, 0.2)',
      boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5)',
      zIndex: 100,
    }),
    menuList: (base) => ({
      ...base,
      maxHeight: '300px',
      padding: '4px',
    }),
    group: (base) => ({
      ...base,
      paddingTop: '8px',
      paddingBottom: '4px',
    }),
    groupHeading: (base) => ({
      ...base,
      color: '#b9a988',
      fontSize: '11px',
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
      marginBottom: '4px',
      paddingLeft: '8px',
    }),
    option: (base, state) => ({
      ...base,
      backgroundColor: state.isSelected
        ? 'rgba(212, 145, 60, 0.3)'
        : state.isFocused
          ? 'rgba(212, 145, 60, 0.15)'
          : 'transparent',
      color: state.isSelected ? '#fdf6e9' : '#e8dcc6',
      padding: '8px 12px',
      borderRadius: '3px',
      cursor: 'pointer',
      fontSize: '13px',
      '&:active': {
        backgroundColor: 'rgba(212, 145, 60, 0.4)',
      },
    }),
    singleValue: (base) => ({
      ...base,
      color: '#e8dcc6',
      fontSize: '13px',
    }),
    input: (base) => ({
      ...base,
      color: '#e8dcc6',
    }),
    placeholder: (base) => ({
      ...base,
      color: '#82735a',
      fontSize: '13px',
    }),
    indicatorSeparator: () => ({
      display: 'none',
    }),
    dropdownIndicator: (base) => ({
      ...base,
      color: '#82735a',
      padding: '6px',
      '&:hover': {
        color: '#b9a988',
      },
    }),
    clearIndicator: (base) => ({
      ...base,
      color: '#82735a',
      padding: '6px',
      '&:hover': {
        color: '#d98c70',
      },
    }),
    noOptionsMessage: (base) => ({
      ...base,
      color: '#82735a',
      fontSize: '13px',
    }),
    loadingMessage: (base) => ({
      ...base,
      color: '#82735a',
    }),
  };

  return (
    <Select
      options={options}
      value={selectedOption}
      onChange={(option) => onChange(option ? option.value : '')}
      placeholder={placeholder}
      isDisabled={isDisabled}
      isLoading={isLoading}
      isClearable
      isSearchable
      styles={customStyles}
      classNamePrefix="model-select"
      noOptionsMessage={() => "No models found"}
      loadingMessage={() => "Loading models..."}
      filterOption={(option, inputValue) => {
        if (!inputValue) return true;
        const searchLower = inputValue.toLowerCase();
        // Search in both label and value (model ID)
        return (
          option.label.toLowerCase().includes(searchLower) ||
          option.value.toLowerCase().includes(searchLower)
        );
      }}
    />
  );
}
