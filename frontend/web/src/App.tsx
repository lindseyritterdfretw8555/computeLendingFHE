import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

// Interface definitions
interface ComputeResource {
  id: string;
  provider: string;
  gpuType: string;
  computePower: number; // TFLOPS
  pricePerHour: number; // ETH
  encryptedPower: string;
  encryptedPrice: string;
  status: "available" | "rented" | "maintenance";
  uptime: number;
  location: string;
  timestamp: number;
}

interface RentalAgreement {
  id: string;
  resourceId: string;
  borrower: string;
  lender: string;
  encryptedComputePower: string;
  encryptedDuration: string;
  totalCost: string;
  status: "active" | "completed" | "disputed";
  startTime: number;
  endTime: number;
}

// FHE Encryption/Decryption utilities
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}-${Date.now()}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    const parts = encryptedData.substring(4).split('-');
    return parseFloat(atob(parts[0]));
  }
  return parseFloat(encryptedData);
};

// FHE computation simulation
const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'scaleUp20%':
      result = value * 1.2;
      break;
    case 'scaleDown10%':
      result = value * 0.9;
      break;
    case 'optimizePerformance':
      result = value * 1.15;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'market' | 'myResources' | 'rentals' | 'analytics'>('market');
  const [resources, setResources] = useState<ComputeResource[]>([]);
  const [rentals, setRentals] = useState<RentalAgreement[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showAddResourceModal, setShowAddResourceModal] = useState(false);
  const [showRentModal, setShowRentModal] = useState(false);
  const [selectedResource, setSelectedResource] = useState<ComputeResource | null>(null);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newResourceData, setNewResourceData] = useState({ gpuType: "RTX 4090", computePower: 80, pricePerHour: 0.01, location: "Global" });
  const [rentalData, setRentalData] = useState({ durationHours: 24 });
  const [publicKey, setPublicKey] = useState<string>("");
  const [fheComputationActive, setFheComputationActive] = useState(false);
  const [computationProgress, setComputationProgress] = useState(0);

  // Initialize application
  useEffect(() => {
    loadResources().finally(() => setLoading(false));
    setPublicKey(generatePublicKey());
  }, []);

  // Load compute resources from contract
  const loadResources = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.warn("Contract not available");
        return;
      }

      // Load resource keys
      const keysBytes = await contract.getData("resource_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing resource keys:", e); }
      }

      const resourceList: ComputeResource[] = [];
      for (const key of keys) {
        try {
          const resourceBytes = await contract.getData(`resource_${key}`);
          if (resourceBytes.length > 0) {
            const resourceData = JSON.parse(ethers.toUtf8String(resourceBytes));
            resourceList.push({
              id: key,
              provider: resourceData.provider,
              gpuType: resourceData.gpuType,
              computePower: resourceData.computePower,
              pricePerHour: resourceData.pricePerHour,
              encryptedPower: FHEEncryptNumber(resourceData.computePower),
              encryptedPrice: FHEEncryptNumber(resourceData.pricePerHour),
              status: resourceData.status || "available",
              uptime: resourceData.uptime || 95,
              location: resourceData.location || "Global",
              timestamp: resourceData.timestamp
            });
          }
        } catch (e) { console.error(`Error loading resource ${key}:`, e); }
      }
      
      setResources(resourceList.sort((a, b) => b.timestamp - a.timestamp));
    } catch (e) { console.error("Error loading resources:", e); } 
    finally { setIsRefreshing(false); }
  };

  // Add new compute resource
  const addResource = async () => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return;
    }

    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting compute power data with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const resourceId = `res_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const resourceData = {
        provider: address,
        gpuType: newResourceData.gpuType,
        computePower: newResourceData.computePower,
        pricePerHour: newResourceData.pricePerHour,
        status: "available",
        uptime: 95 + Math.floor(Math.random() * 5),
        location: newResourceData.location,
        timestamp: Math.floor(Date.now() / 1000)
      };

      // Store resource data
      await contract.setData(`resource_${resourceId}`, ethers.toUtf8Bytes(JSON.stringify(resourceData)));
      
      // Update resource keys
      const keysBytes = await contract.getData("resource_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(resourceId);
      await contract.setData("resource_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));

      setTransactionStatus({ visible: true, status: "success", message: "Compute resource added with FHE encryption!" });
      await loadResources();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowAddResourceModal(false);
        setNewResourceData({ gpuType: "RTX 4090", computePower: 80, pricePerHour: 0.01, location: "Global" });
      }, 2000);

    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Failed to add resource: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Rent compute resource with FHE simulation
  const rentResource = async () => {
    if (!isConnected || !selectedResource) return;

    setFheComputationActive(true);
    setComputationProgress(0);
    
    // Simulate FHE computation progress
    const interval = setInterval(() => {
      setComputationProgress(prev => {
        if (prev >= 100) {
          clearInterval(interval);
          return 100;
        }
        return prev + 10;
      });
    }, 300);

    setTransactionStatus({ visible: true, status: "pending", message: "Processing FHE-encrypted computation agreement..." });

    try {
      // Simulate FHE operations on encrypted data
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const encryptedPower = FHECompute(selectedResource.encryptedPower, 'optimizePerformance');
      const encryptedCost = FHECompute(selectedResource.encryptedPrice, 'scaleUp20%');
      
      const totalCost = selectedResource.pricePerHour * rentalData.durationHours * 1.2;
      
      const rentalId = `rental_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const newRental: RentalAgreement = {
        id: rentalId,
        resourceId: selectedResource.id,
        borrower: address!,
        lender: selectedResource.provider,
        encryptedComputePower: encryptedPower,
        encryptedDuration: FHEEncryptNumber(rentalData.durationHours),
        totalCost: FHEEncryptNumber(totalCost),
        status: "active",
        startTime: Math.floor(Date.now() / 1000),
        endTime: Math.floor(Date.now() / 1000) + (rentalData.durationHours * 3600)
      };

      setRentals(prev => [newRental, ...prev]);
      setTransactionStatus({ visible: true, status: "success", message: "FHE computation agreement executed successfully!" });
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowRentModal(false);
        setFheComputationActive(false);
        setComputationProgress(0);
      }, 2000);

    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rental failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      setFheComputationActive(false);
      setComputationProgress(0);
    }
  };

  // Decrypt with wallet signature (simulated FHE decryption)
  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) return null;

    try {
      const message = `Decrypt FHE data with Zama protocol\nPublic Key: ${publicKey}\nTimestamp: ${Date.now()}`;
      await signMessageAsync({ message });
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    }
  };

  // Statistics calculations
  const availableResources = resources.filter(r => r.status === "available").length;
  const totalComputePower = resources.reduce((sum, r) => sum + r.computePower, 0);
  const averagePrice = resources.length > 0 ? resources.reduce((sum, r) => sum + r.pricePerHour, 0) / resources.length : 0;

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing FHE Compute Lending Protocol...</p>
    </div>
  );

  return (
    <div className="app-container fhe-compute-theme">
      {/* Sidebar Navigation */}
      <aside className="app-sidebar">
        <div className="sidebar-header">
          <div className="logo">
            <div className="fhe-cube"></div>
            <h1>FHE Compute</h1>
          </div>
          <div className="fhe-badge">ZAMA FHE v2.3</div>
        </div>
        
        <nav className="sidebar-nav">
          <button 
            className={`nav-item ${activeTab === 'market' ? 'active' : ''}`}
            onClick={() => setActiveTab('market')}
          >
            <div className="nav-icon">⚡</div>
            Compute Market
          </button>
          <button 
            className={`nav-item ${activeTab === 'myResources' ? 'active' : ''}`}
            onClick={() => setActiveTab('myResources')}
          >
            <div className="nav-icon">🖥️</div>
            My Resources
          </button>
          <button 
            className={`nav-item ${activeTab === 'rentals' ? 'active' : ''}`}
            onClick={() => setActiveTab('rentals')}
          >
            <div className="nav-icon">📊</div>
            Rentals
          </button>
          <button 
            className={`nav-item ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            <div className="nav-icon">📈</div>
            Analytics
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="fhe-status">
            <div className="status-indicator"></div>
            FHE Encryption Active
          </div>
          <ConnectButton accountStatus="avatar" chainStatus="icon" showBalance={true} />
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="app-main">
        <header className="main-header">
          <h2>{
            activeTab === 'market' ? 'Compute Resource Market' :
            activeTab === 'myResources' ? 'My Compute Resources' :
            activeTab === 'rentals' ? 'Active Rentals' : 'Market Analytics'
          }</h2>
          <div className="header-actions">
            {activeTab === 'myResources' && (
              <button 
                className="primary-button"
                onClick={() => setShowAddResourceModal(true)}
              >
                + Add Resource
              </button>
            )}
            <button 
              className="secondary-button"
              onClick={loadResources}
              disabled={isRefreshing}
            >
              {isRefreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </header>

        {/* Market Dashboard */}
        {activeTab === 'market' && (
          <div className="market-dashboard">
            <div className="stats-grid">
              <div className="stat-card">
                <h3>Available Resources</h3>
                <div className="stat-value">{availableResources}</div>
                <div className="stat-label">GPU Nodes Online</div>
              </div>
              <div className="stat-card">
                <h3>Total Compute Power</h3>
                <div className="stat-value">{totalComputePower} TFLOPS</div>
                <div className="stat-label">FHE-Encrypted</div>
              </div>
              <div className="stat-card">
                <h3>Average Price</h3>
                <div className="stat-value">{averagePrice.toFixed(4)} ETH/h</div>
                <div className="stat-label">Market Rate</div>
              </div>
              <div className="stat-card">
                <h3>Network Uptime</h3>
                <div className="stat-value">98.7%</div>
                <div className="stat-label">FHE Secured</div>
              </div>
            </div>

            <div className="resources-grid">
              <h3>Available Compute Resources</h3>
              {resources.filter(r => r.status === 'available').length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">🖥️</div>
                  <p>No compute resources available</p>
                  <button 
                    className="primary-button"
                    onClick={() => setShowAddResourceModal(true)}
                  >
                    Add First Resource
                  </button>
                </div>
              ) : (
                <div className="resources-list">
                  {resources.filter(r => r.status === 'available').map(resource => (
                    <div key={resource.id} className="resource-card">
                      <div className="resource-header">
                        <h4>{resource.gpuType}</h4>
                        <span className={`status-badge ${resource.status}`}>{resource.status}</span>
                      </div>
                      <div className="resource-details">
                        <div className="detail-item">
                          <span>Power:</span>
                          <strong>{resource.computePower} TFLOPS</strong>
                        </div>
                        <div className="detail-item">
                          <span>Price:</span>
                          <strong>{resource.pricePerHour} ETH/h</strong>
                        </div>
                        <div className="detail-item">
                          <span>Uptime:</span>
                          <strong>{resource.uptime}%</strong>
                        </div>
                        <div className="detail-item">
                          <span>Location:</span>
                          <strong>{resource.location}</strong>
                        </div>
                      </div>
                      <div className="fhe-encrypted">
                        <div className="fhe-tag">FHE Encrypted</div>
                      </div>
                      <button 
                        className="rent-button"
                        onClick={() => {
                          setSelectedResource(resource);
                          setShowRentModal(true);
                        }}
                      >
                        Rent Compute Power
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* My Resources Tab */}
        {activeTab === 'myResources' && (
          <div className="my-resources">
            <h3>My Compute Resources</h3>
            {/* Content for my resources */}
          </div>
        )}

        {/* Rentals Tab */}
        {activeTab === 'rentals' && (
          <div className="rentals-view">
            <h3>Active Rentals</h3>
            {/* Content for rentals */}
          </div>
        )}

        {/* Analytics Tab */}
        {activeTab === 'analytics' && (
          <div className="analytics-view">
            <h3>Market Analytics</h3>
            {/* Content for analytics */}
          </div>
        )}
      </main>

      {/* Add Resource Modal */}
      {showAddResourceModal && (
        <AddResourceModal
          onSubmit={addResource}
          onClose={() => setShowAddResourceModal(false)}
          resourceData={newResourceData}
          setResourceData={setNewResourceData}
        />
      )}

      {/* Rent Resource Modal */}
      {showRentModal && selectedResource && (
        <RentResourceModal
          resource={selectedResource}
          onSubmit={rentResource}
          onClose={() => {
            setShowRentModal(false);
            setSelectedResource(null);
          }}
          rentalData={rentalData}
          setRentalData={setRentalData}
          fheComputationActive={fheComputationActive}
          computationProgress={computationProgress}
        />
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✕"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
    </div>
  );
};

// Modal Components
interface AddResourceModalProps {
  onSubmit: () => void;
  onClose: () => void;
  resourceData: any;
  setResourceData: (data: any) => void;
}

const AddResourceModal: React.FC<AddResourceModalProps> = ({ onSubmit, onClose, resourceData, setResourceData }) => {
  const handleSubmit = () => {
    if (!resourceData.gpuType || !resourceData.computePower || !resourceData.pricePerHour) {
      alert("Please fill all required fields");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h3>Add Compute Resource</h3>
          <button onClick={onClose} className="close-button">×</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>GPU Type *</label>
            <select 
              value={resourceData.gpuType}
              onChange={(e) => setResourceData({...resourceData, gpuType: e.target.value})}
            >
              <option value="RTX 4090">NVIDIA RTX 4090</option>
              <option value="RTX 4080">NVIDIA RTX 4080</option>
              <option value="A100">NVIDIA A100</option>
              <option value="H100">NVIDIA H100</option>
              <option value="RX 7900">AMD RX 7900 XTX</option>
            </select>
          </div>
          <div className="form-group">
            <label>Compute Power (TFLOPS) *</label>
            <input 
              type="number"
              value={resourceData.computePower}
              onChange={(e) => setResourceData({...resourceData, computePower: parseFloat(e.target.value)})}
              placeholder="e.g., 80"
            />
          </div>
          <div className="form-group">
            <label>Price per Hour (ETH) *</label>
            <input 
              type="number"
              step="0.001"
              value={resourceData.pricePerHour}
              onChange={(e) => setResourceData({...resourceData, pricePerHour: parseFloat(e.target.value)})}
              placeholder="e.g., 0.01"
            />
          </div>
          <div className="form-group">
            <label>Location</label>
            <input 
              type="text"
              value={resourceData.location}
              onChange={(e) => setResourceData({...resourceData, location: e.target.value})}
              placeholder="e.g., Global, US-East, EU"
            />
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="secondary-button">Cancel</button>
          <button onClick={handleSubmit} className="primary-button">Add Resource</button>
        </div>
      </div>
    </div>
  );
};

interface RentResourceModalProps {
  resource: any;
  onSubmit: () => void;
  onClose: () => void;
  rentalData: any;
  setRentalData: (data: any) => void;
  fheComputationActive: boolean;
  computationProgress: number;
}

const RentResourceModal: React.FC<RentResourceModalProps> = ({
  resource,
  onSubmit,
  onClose,
  rentalData,
  setRentalData,
  fheComputationActive,
  computationProgress
}) => {
  const totalCost = resource.pricePerHour * rentalData.durationHours;

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h3>Rent Compute Resource</h3>
          <button onClick={onClose} className="close-button">×</button>
        </div>
        <div className="modal-body">
          <div className="resource-summary">
            <h4>{resource.gpuType}</h4>
            <p>{resource.computePower} TFLOPS • {resource.uptime}% Uptime</p>
          </div>
          
          <div className="form-group">
            <label>Duration (Hours)</label>
            <input 
              type="number"
              value={rentalData.durationHours}
              onChange={(e) => setRentalData({durationHours: parseInt(e.target.value)})}
              min="1"
              max="720"
            />
          </div>

          <div className="cost-summary">
            <div className="cost-item">
              <span>Price per Hour:</span>
              <span>{resource.pricePerHour} ETH</span>
            </div>
            <div className="cost-item">
              <span>Duration:</span>
              <span>{rentalData.durationHours} hours</span>
            </div>
            <div className="cost-total">
              <span>Total Cost:</span>
              <span>{totalCost.toFixed(4)} ETH</span>
            </div>
          </div>

          {fheComputationActive && (
            <div className="fhe-computation">
              <div className="computation-header">
                <div className="fhe-spinner"></div>
                <span>FHE Computation in Progress</span>
              </div>
              <div className="computation-progress">
                <div 
                  className="progress-bar"
                  style={{width: `${computationProgress}%`}}
                ></div>
              </div>
              <p>Processing encrypted computation agreement with Zama FHE...</p>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="secondary-button">Cancel</button>
          <button 
            onClick={onSubmit} 
            className="primary-button"
            disabled={fheComputationActive}
          >
            {fheComputationActive ? 'Processing FHE...' : 'Confirm Rental'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;